'use strict';

const {v4: uuidv4} = require('uuid');
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const {Server} = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:4000", "https://mattw.io"],
        methods: ["GET", "POST"],
        allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept"],
    }
});
const NodeCache = require("node-cache");
const cache = new NodeCache({
    stdTTL: 60 * 60 * 24, // 24 hour cache, depends on keep-alive at bottom
    checkperiod: 30
});
cache.on("expired", function (key, value) {
    console.log('room expired ' + key);

    io.to(key).emit('room-expired');
});
const idToRoom = new NodeCache();
const idToRole = new NodeCache();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// returns reason if failure
function authenticate(socket, room, message) {
    if (message.editorKey && message.editorKey.length &&
        message.editorKey !== room.editorKey) {
        console.log(message.editorKey + " !== " + room.editorKey)
        return {reason: "Bad editor key"}
    }
    if (room.viewerPassword && room.viewerPassword.length &&
        room.viewerPassword !== message.viewerPassword) {
        return {reason: "Room has viewer password set but did not match"}
    }
}

// Sanitize user input and apply array limits
function sanitizeMessage(message) {
    if (!message) {
        return;
    }

    const cleaned = {};
    if (message.role) {
        cleaned.role = sanitize(message.role);
    }
    if (message.roomId) {
        cleaned.roomId = sanitize(message.roomId);
    }
    if (message.viewerPassword) {
        cleaned.viewerPassword = sanitize(message.viewerPassword);
    }
    if (message.editorKey) {
        cleaned.editorKey = sanitize(message.editorKey);
    }
    if (message.controlsChange) {
        cleaned.controlsChange = sanitize(message.controlsChange);
    }
    if (message.state) {
        cleaned.state = {};

        const state = message.state;
        if (state.controls) {
            cleaned.state.controls = state.controls;

            if (state.controls.selectedSp) {
                cleaned.state.controls.selectedSp = state.controls.selectedSp.slice(0, 25);
            }
        }
        if (state.elements) {
            cleaned.state.elements = state.elements.slice(0, 1000);
        }
        if (state.drawings) {
            cleaned.state.drawings = state.drawings.slice(0, 1000);
        }
    }
    if (message.slideId) {
        cleaned.slideId = sanitize(message.slideId);
    }
    if (message.slides) {
        cleaned.slides = message.slides || [];
    }
    return cleaned;
}

function sanitize(input) {
    return String(input).trim()
        .substring(0, 50)
        .replaceAll(/[^\w+ !@#$&%=,/\-\[\]]/gi, '');
}

function updateSlideState(roomId, slideId, stateType, state) {
    const roomState = cache.get(roomId);
    for (let i = 0; i < roomState.slides.length; i++) {
        if (roomState.slides[i].id === slideId) {
            roomState.slides[i].state[stateType] = state;

            console.warn(`updateSlideState(${roomId}, ${slideId}, ${stateType}, ${JSON.stringify(state).length}) slideId found, updated`);
            cache.set(roomId, roomState);
            return;
        }
    }

    console.warn(`updateSlideState(${roomId}, ${slideId}, ${stateType}, ${JSON.stringify(state).length}) slideId not found, no update`);
}

io.on('leave-room', function (room, id) {
    idToRoom.set(id, null);
    idToRole.set(id, null);
})

io.on('connection', (socket) => {
    function jsonLength(json) {
        return json ? JSON.stringify(json).length : -1;
    }

    function logPrefix(eventName) {
        return `socket=${socket.id} room=${idToRoom.get(socket.id) || "none"} role=${idToRole.get(socket.id) || "none"} event=${eventName}`
    }

    console.log(`${logPrefix("connection")}`);

    function getRoomStatus(roomId) {
        const response = {connected: 0, viewers: 0, editors: 0}

        const clients = io.sockets.adapter.rooms.get(roomId);
        if (clients) {
            response.connected = clients.size;

            clients.forEach(function (clientId) {
                const role = idToRole.get(clientId);
                if (role === 'viewer') {
                    response.viewers = response.viewers + 1;
                } else if (role === 'editor') {
                    response.editors = response.editors + 1;
                }
            });
        }

        return response;
    }

    function updateRoomStatus(roomId) {
        io.to(roomId).emit('room-status', getRoomStatus(roomId));
    }

    idToRoom.set(socket.id, null)

    socket.on('disconnect', (reason) => {
        const roomId = idToRoom.get(socket.id);

        console.log(`${logPrefix("disconnect")}`)

        idToRole.del(socket.id);
        if (!roomId) {
            return;
        }
        updateRoomStatus(roomId);
        idToRoom.del(socket.id);
    });

    socket.on('create-or-join', (message) => {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("create-or-join")} message=${JSON.stringify(message)}`);

        const room = cache.get(message.roomId);
        if (room) {
            const reason = authenticate(socket, room, message);
            if (reason) {
                console.log(`${logPrefix("create-or-join")} join-error ${JSON.stringify(reason)}`);
                io.to(socket.id).emit('join-error', reason);
                return;
            }

            if (message.editorKey && message.editorKey.length && message.editorKey === room.editorKey) {
                room.role = 'editor';
            } else {
                room.role = 'viewer';
                room.editorKey = "";
            }

            idToRole.set(socket.id, room.role);
            idToRoom.set(socket.id, room.roomId);

            console.log(`${logPrefix("create-or-join")} joined existing room length=${JSON.stringify(room).length}`)

            socket.join(room.roomId);
            const returnData = room;
            if (cache.has(room.roomId)) {
                const roomData = cache.get(room.roomId);
                if (roomData.slides) {
                    returnData.slides = roomData.slides;
                }
            }
            io.to(socket.id).emit('join-success', returnData);
            updateRoomStatus(room.roomId);
        } else {
            if (!message.editorKey || message.editorKey.length === 0) {
                message.editorKey = uuidv4();
            }

            message.role = 'editor';
            idToRole.set(socket.id, 'editor');
            idToRoom.set(socket.id, message.roomId);

            cache.set(message.roomId, message);
            socket.join(message.roomId);

            console.log(`${logPrefix("create-or-join")} creating new room ${JSON.stringify(message)}`);

            io.to(socket.id).emit('join-success', message);
            updateRoomStatus(message.roomId);
        }
    });

    socket.on('editor-controls', (message) => {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("editor-controls")} action=${message.controlsChange} length=${jsonLength(message)}`);

        const room = cache.get(message.roomId);
        if (!message.editorKey || message.editorKey !== room.editorKey) {
            console.log(`${logPrefix("editor-controls")} editor bad key ${message.editorKey} !== ${room.editorKey}`);
            io.to(socket.id).emit('join-error', {reason: "Bad editor key, cannot update"});
            return;
        }

        if (room) {
            if (!room.state) {
                room.state = {};
            }

            if (JSON.stringify(message.state.controls) === JSON.stringify(room.state.controls)) {
                console.log(`${logPrefix("editor-controls")} but nothing changed, ignoring`)
                return;
            }

            room.state.controls = message.state.controls;
        }

        // cache.set(message.roomId, room);
        updateSlideState(message.roomId, message.slideId, 'controls', message.state.controls);
        socket.to(message.roomId).emit('update-controls', message);
    });

    socket.on('editor-elements', (message) => {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("editor-elements")} items=${message && message.state && message.state.elements ? message.state.elements.length : -1} length=${jsonLength(message)}`);

        const room = cache.get(message.roomId);
        if (!message.editorKey || message.editorKey !== room.editorKey) {
            console.log(`${socket.id} editor bad key ${message.editorKey} !== ${room.editorKey}`);
            io.to(socket.id).emit('join-error', {reason: "Bad editor key, cannot update"});
            return;
        }

        if (room) {
            if (!room.state) {
                room.state = {};
            }
            room.state.elements = message.state.elements.slice(0, 200);
        }

        // cache.set(message.roomId, room);
        updateSlideState(message.roomId, message.slideId, 'elements', message.state.elements);
        socket.to(message.roomId).emit('update-elements', message);
    });

    socket.on('editor-drawings', (message) => {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("editor-drawings")} items=${message && message.state && message.state.drawings ? message.state.drawings.length : -1} length=${jsonLength(message)}`)

        const room = cache.get(message.roomId);
        if (!message.editorKey || message.editorKey !== room.editorKey) {
            console.log(`${socket.id} editor bad key ${message.editorKey} !== ${room.editorKey}`);
            io.to(socket.id).emit('join-error', {reason: "Bad editor key, cannot update"});
            return;
        }

        if (room) {
            if (!room.state) {
                room.state = {};
            }
            room.state.drawings = message.state.drawings.slice(0, 200);
        }

        // cache.set(message.roomId, room);
        updateSlideState(message.roomId, message.slideId, 'drawings', message.state.drawings);
        socket.to(message.roomId).emit('update-drawings', message);
    });

    socket.on('editor-slides', (message) => {
        message = sanitizeMessage(message);

        console.log(`${logPrefix('editor-slides')} slides=${message && message.slides ? message.slides.length : -1} length=${jsonLength(message)}`);

        const room = cache.get(message.roomId);
        if (!message.editorKey || message.editorKey !== room.editorKey) {
            console.log(`${socket.id} editor bad key ${message.editorKey} !== ${room.editorKey}`);
            io.to(socket.id).emit('join-error', {reason: "Bad editor key, cannot update"});
            return;
        }

        room.slides = message.slides;
        cache.set(message.roomId, room);
        socket.to(message.roomId).emit('update-slides', message);
    });

    socket.on('leave-room', (message) => {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("leave-room")}`)

        const roomId = (message || {}).roomId || idToRoom.get(socket.id);

        socket.leave(roomId);

        idToRole.set(socket.id, null);
        idToRoom.set(socket.id, null);
        updateRoomStatus(roomId);
    });

    socket.on('update-room-pw', function (message) {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("update-room-pw")} message=${JSON.stringify(message)}`)

        const room = cache.get(message.roomId);
        if (!message.editorKey || message.editorKey !== room.editorKey) {
            console.log(`${socket.id} editor bad key ${message.editorKey} !== ${room.editorKey}`);
            io.to(socket.id).emit('join-error', {reason: "Bad editor key, cannot update"});
            return;
        }

        room.viewerPassword = message.viewerPassword;

        cache.set(message.roomId, room);

        io.to(message.roomId).emit('room-pw-change', {blankPw: room.viewerPassword == ""})
    });

    socket.on('editor-get-pw', function (message) {
        message = sanitizeMessage(message);

        console.log(`${logPrefix("editor-get-pw")} message=${JSON.stringify(message)}`)

        const room = cache.get(message.roomId);
        if (!message.editorKey || message.editorKey !== room.editorKey) {
            console.log(`${socket.id} editor bad key ${message.editorKey} !== ${room.editorKey}`);
            io.to(socket.id).emit('join-error', {reason: "Bad editor key, cannot update"});
            return;
        }

        io.to(socket.id).emit('editor-get-pw', cache.get(message.roomId))
    })
});

server.listen(process.env.PORT || 3000, () => {
    console.log('listening on *:3000');
});

// Keep Heroku Dyno alive, pings every 5 minutes
setInterval(function() {
    http.get("http://maps-let-loose-websocket.herokuapp.com");
}, 300000);
