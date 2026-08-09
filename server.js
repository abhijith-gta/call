const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const path = require("path");

const sanitize = (str) => {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
};

const io = new Server(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 5000;
app.use(express.static(path.join(__dirname, "public")));

http.listen(PORT, () => {
    console.log(`🚀 SwapLoop Server running on port ${PORT}`);
});

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "idiot", "stupid", "nude", "nsfw"];
const containsBadWords = (text) => {
    if (!text) return false;
    return BAD_WORDS.some(word => text.toLowerCase().includes(word));
};

const users = new Map();
let textWaitingPool = [];
let voiceWaitingPool = [];
let videoWaitingPool = [];

// Storage for Reports
const reportLedger = new Map();

const updateOnlineCount = () => {
    io.emit("online-count", users.size);
};

function findMatch(newUserSocketId) {
    const userA = users.get(newUserSocketId);
    if (!userA || userA.partnerId) return;

    let pool = userA.type === 'text' ? textWaitingPool : userA.type === 'voice' ? voiceWaitingPool : videoWaitingPool;

    const candidates = pool.filter(id => {
        if (id === newUserSocketId) return false;
        const userB = users.get(id);
        if (!userB || userB.partnerId) return false;

        // 🛑 BLOCKLIST: Report cheytha aalumaayi pinne connect aavilla
        if (userA.blocked.has(id) || userB.blocked.has(newUserSocketId)) return false;

        const aWantsB = userA.lookingFor === 'anyone' || userA.lookingFor === userB.gender;
        const bWantsA = userB.lookingFor === 'anyone' || userB.lookingFor === userA.gender;
        return aWantsB && bWantsA;
    });

    if (candidates.length === 0) return;

    let partnerId = candidates[0];

    if (partnerId) {
        const userB = users.get(partnerId);

        // Save Current & Last Partner on SERVER SIDE (This fixes the hit-and-run report issue!)
        userA.partnerId = userB.socket.id;
        userA.lastPartnerId = userB.socket.id;
        
        userB.partnerId = userA.socket.id;
        userB.lastPartnerId = userA.socket.id;

        if (userA.type === 'text') textWaitingPool = textWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        else if (userA.type === 'voice') voiceWaitingPool = voiceWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        else videoWaitingPool = videoWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);

        console.log(`✅ Matched: ${userA.nickname} <-> ${userB.nickname}`);

        userA.socket.emit("partner-found", { initiator: true, partnerNickname: userB.nickname });
        userB.socket.emit("partner-found", { initiator: false, partnerNickname: userA.nickname });
    }
}

io.on("connection", socket => {
    console.log("🟢 Connected:", socket.id);
    users.set(socket.id, { 
        socket, nickname: "Stranger", 
        partnerId: null, lastPartnerId: null, 
        interests: [], blocked: new Set() 
    });
    updateOnlineCount();

    socket.on("set-nickname", nickname => {
        const user = users.get(socket.id);
        if (user) user.nickname = sanitize(nickname).substring(0, 20);
    });

    socket.on("find-partner", (preferences) => {
        const user = users.get(socket.id);
        if (!user || user.partnerId) return;

        user.gender = preferences.gender;
        user.lookingFor = preferences.lookingFor;
        user.type = preferences.type;
        
        let pool = user.type === 'text' ? textWaitingPool : user.type === 'voice' ? voiceWaitingPool : videoWaitingPool;
        if (!pool.includes(socket.id)) pool.push(socket.id);

        findMatch(socket.id);
    });

    socket.on("signal", data => {
        const user = users.get(socket.id);
        if (user?.partnerId) {
            const partner = users.get(user.partnerId);
            if (partner) partner.socket.emit("signal", data);
        }
    });

    // --- REPORT & BAN SYSTEM (Server identifies the user) ---
    socket.on("report-user", ({ reason }) => {
        const user = users.get(socket.id);
        if (!user) return;

        // Automatically get the last person they were talking to
        const targetId = user.partnerId || user.lastPartnerId;
        
        if (!targetId || targetId === socket.id || !users.has(targetId)) return;

        // 1. Block Immediately
        user.blocked.add(targetId);
        const reportedUser = users.get(targetId);
        if (reportedUser) reportedUser.blocked.add(socket.id);

        // 2. Count Report
        if (!reportLedger.has(targetId)) {
            reportLedger.set(targetId, { total: 0, reporters: new Set() });
        }
        const record = reportLedger.get(targetId);

        if (record.reporters.has(socket.id)) return; // Prevents spam
        
        record.reporters.add(socket.id);
        record.total += 1;
        console.log(`🚩 Report against ${targetId}. Total: ${record.total}`);

        // 3. IF 2 REPORTS = 24 HR BAN
        if (record.total >= 2) {
            console.log(`🔨 User ${targetId} BANNED.`);
            if (reportedUser) {
                reportedUser.socket.emit("you-are-banned"); 
                
                if (reportedUser.partnerId) {
                    const theirPartner = users.get(reportedUser.partnerId);
                    if (theirPartner) {
                        theirPartner.partnerId = null;
                        theirPartner.socket.emit("partner-disconnected");
                    }
                }
                users.delete(targetId);
                textWaitingPool = textWaitingPool.filter(id => id !== targetId);
                voiceWaitingPool = voiceWaitingPool.filter(id => id !== targetId);
                videoWaitingPool = videoWaitingPool.filter(id => id !== targetId);
                updateOnlineCount();
            }
            reportLedger.delete(targetId);
        }
    });

    socket.on("send-message", ({ message }) => {
        const user = users.get(socket.id);
        if (user?.partnerId) {
            const partner = users.get(user.partnerId);
            if (partner) {
                const sanitizedMessage = sanitize(message);
                if (containsBadWords(sanitizedMessage)) {
                    socket.emit("receive-message", { message: "⚠️ Warning: Inappropriate language." });
                    return; 
                }
                partner.socket.emit("receive-message", { message: sanitizedMessage });
            }
        }
    });

    const handleDisconnectOrNext = () => {
        const user = users.get(socket.id);
        if (!user) return;

        textWaitingPool = textWaitingPool.filter(id => id !== socket.id);
        voiceWaitingPool = voiceWaitingPool.filter(id => id !== socket.id);
        videoWaitingPool = videoWaitingPool.filter(id => id !== socket.id);

        const partnerId = user.partnerId;
        if (partnerId) {
            const partner = users.get(partnerId);
            if (partner) {
                partner.partnerId = null;
                partner.socket.emit("partner-disconnected");
            }
        }
        user.partnerId = null; // Do NOT clear lastPartnerId, so they can still report them!
    };

    socket.on("next", handleDisconnectOrNext);
    socket.on("disconnect", () => {
        handleDisconnectOrNext();
        users.delete(socket.id);
        updateOnlineCount();
    });
});
