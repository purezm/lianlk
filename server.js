const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// 存储数据（内存中）
const classes = new Map();        // classCode -> classData
const playerSockets = new Map();  // playerName -> ws

// 班级数据结构
function createClass(code, name, hostName, hostAvatar) {
    return {
        code,
        name,
        hostName,
        createdAt: Date.now(),
        members: [{
            name: hostName,
            avatar: hostAvatar,
            wins: 0,
            isHost: true,
            lastActive: Date.now()
        }]
    };
}

// 生成唯一班级号
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// 生成唯一ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ==================== REST API ====================

// 创建班级
app.post('/api/classes', (req, res) => {
    const { className, hostName, hostAvatar } = req.body;

    if (!className || !hostName) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    let code;
    do {
        code = generateCode();
    } while (classes.has(code));

    const classData = createClass(code, className, hostName, hostAvatar);
    classes.set(code, classData);

    console.log(`班级创建: ${className} (${code}) by ${hostName}`);

    res.json({
        success: true,
        data: {
            code,
            className,
            members: classData.members
        }
    });
});

// 加入班级
app.post('/api/classes/join', (req, res) => {
    const { code, playerName, playerAvatar } = req.body;

    if (!code || !playerName) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    const classData = classes.get(code);
    if (!classData) {
        return res.status(404).json({ error: '班级不存在' });
    }

    // 检查是否已加入
    const existingMember = classData.members.find(m => m.name === playerName);
    if (existingMember) {
        existingMember.lastActive = Date.now();
    } else {
        classData.members.push({
            name: playerName,
            avatar: playerAvatar || '🙂',
            wins: 0,
            isHost: false,
            lastActive: Date.now()
        });
    }

    console.log(`${playerName} 加入班级 ${code}`);

    res.json({
        success: true,
        data: {
            code: classData.code,
            className: classData.name,
            members: classData.members
        }
    });
});

// 获取班级信息
app.get('/api/classes/:code', (req, res) => {
    const { code } = req.params;
    const classData = classes.get(code);

    if (!classData) {
        return res.status(404).json({ error: '班级不存在' });
    }

    res.json({
        success: true,
        data: {
            code: classData.code,
            className: classData.name,
            members: classData.members
        }
    });
});

// 退出班级
app.post('/api/classes/leave', (req, res) => {
    const { code, playerName } = req.body;
    const classData = classes.get(code);

    if (!classData) {
        return res.status(404).json({ error: '班级不存在' });
    }

    classData.members = classData.members.filter(m => m.name !== playerName);

    // 如果班级空了，删除班级
    if (classData.members.length === 0) {
        classes.delete(code);
        console.log(`班级 ${code} 已删除（无成员）`);
    } else if (classData.hostName === playerName) {
        // 如果是房主离开，让第一个成员成为房主
        classData.hostName = classData.members[0].name;
        classData.members[0].isHost = true;
    }

    res.json({ success: true });
});

// 更新玩家数据
app.post('/api/players/update', (req, res) => {
    const { code, playerName, wins } = req.body;

    if (!code || !playerName) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    const classData = classes.get(code);
    if (classData) {
        const member = classData.members.find(m => m.name === playerName);
        if (member) {
            member.wins = wins;
            member.lastActive = Date.now();
        }
    }

    res.json({ success: true });
});

// 获取班级成员（轮询）
app.get('/api/classes/:code/members', (req, res) => {
    const { code } = req.params;
    const classData = classes.get(code);

    if (!classData) {
        return res.status(404).json({ error: '班级不存在' });
    }

    res.json({
        success: true,
        data: classData.members
    });
});

// ==================== WebSocket 处理 ====================

wss.on('connection', (ws) => {
    let currentPlayer = null;
    let currentClassCode = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'register':
                    // 玩家注册
                    currentPlayer = data.playerName;
                    playerSockets.set(currentPlayer, ws);
                    currentClassCode = data.classCode;
                    console.log(`${currentPlayer} WebSocket连接`);
                    break;

                case 'pk_invite':
                    // 发送PK邀请
                    const opponentWs = playerSockets.get(data.opponentName);
                    if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                        opponentWs.send(JSON.stringify({
                            type: 'pk_invite',
                            from: currentPlayer,
                            fromAvatar: data.fromAvatar
                        }));
                        ws.send(JSON.stringify({ type: 'pk_sent' }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'pk_error',
                            message: '对方不在线'
                        }));
                    }
                    break;

                case 'pk_accept':
                    // 接受PK邀请
                    const inviterWs = playerSockets.get(data.inviterName);
                    if (inviterWs && inviterWs.readyState === WebSocket.OPEN) {
                        inviterWs.send(JSON.stringify({
                            type: 'pk_accepted',
                            opponent: currentPlayer
                        }));
                        ws.send(JSON.stringify({ type: 'pk_started' }));
                    }
                    break;

                case 'pk_result':
                    // PK结果
                    if (data.opponentName) {
                        const resultWs = playerSockets.get(data.opponentName);
                        if (resultWs && resultWs.readyState === WebSocket.OPEN) {
                            resultWs.send(JSON.stringify({
                                type: 'pk_result',
                                myScore: data.myScore,
                                opponentScore: data.opponentScore,
                                winner: data.winner
                            }));
                        }
                    }
                    break;

                case 'cancel_pk':
                    // 取消PK
                    if (data.opponentName) {
                        const cancelWs = playerSockets.get(data.opponentName);
                        if (cancelWs && cancelWs.readyState === WebSocket.OPEN) {
                            cancelWs.send(JSON.stringify({
                                type: 'pk_cancelled'
                            }));
                        }
                    }
                    break;
            }
        } catch (e) {
            console.error('WebSocket消息处理错误:', e);
        }
    });

    ws.on('close', () => {
        if (currentPlayer) {
            playerSockets.delete(currentPlayer);
            console.log(`${currentPlayer} WebSocket断开`);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket错误:', err);
    });
});

// ==================== 启动服务器 ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║     古诗词连连看 后端服务已启动           ║
║     HTTP: http://localhost:${PORT}            ║
║     WebSocket: ws://localhost:${PORT}          ║
╚════════════════════════════════════════════╝
    `);
});
