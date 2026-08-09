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

// ✨ GLOBAL STORAGE FOR BLOCKS & REPORTS
const clientBlocklists = new Map(); 
const reportLedger = new Map();     

const updateOnlineCount = () => {
    io.emit("online-count", users.size);
};

function findMatch(newUserSocketId) {
    const userA = users.get(newUserSocketId);
    if (!userA || userA.partnerId || !userA.clientId) return;

    let pool = userA.type === 'text' ? textWaitingPool : userA.type === 'voice' ? voiceWaitingPool : videoWaitingPool;

    const candidates = pool.filter(id => {
        if (id === newUserSocketId) return false;
        const userB = users.get(id);
        if (!userB || userB.partnerId || !userB.clientId) return false;

        // 🛑 GLOBAL BLOCKLIST CHECK
        const aBlocks = clientBlocklists.get(userA.clientId) || new Set();
        const bBlocks = clientBlocklists.get(userB.clientId) || new Set();

        if (aBlocks.has(userB.clientId) || bBlocks.has(userA.clientId)) return false;

        // 🛑 STRICT GENDER MATCHING FIX 🛑
        let isMatch = false;

        if (userA.lookingFor === 'anyone' || userB.lookingFor === 'anyone') {
            // Anyone kodutha aalkkar vere Anyone kodutha aalumaayi mathrame connect aavuu
            isMatch = (userA.lookingFor === 'anyone' && userB.lookingFor === 'anyone');
        } else {
            // Strict targeted matching (Male -> Female <-> Female -> Male)
            const aWantsB = (userA.lookingFor === userB.gender);
            const bWantsA = (userB.lookingFor === userA.gender);
            isMatch = (aWantsB && bWantsA);
        }

        return isMatch;
    });

    if (candidates.length === 0) return;

    // ✨ INTEREST MATCHING LOGIC
    let bestCandidate = null;
    let maxCommon = -1;
    let matchedInterest = null;

    for (const id of candidates) {
        const userB = users.get(id);
        const common = userA.interests.filter(interest => userB.interests.includes(interest));
        
        if (common.length > maxCommon) {
            maxCommon = common.length;
            bestCandidate = id;
            matchedInterest = common.length > 0 ? common[0] : null;
        }
    }

    let partnerId = bestCandidate;

    if (partnerId) {
        const userB = users.get(partnerId);

        userA.partnerId = userB.socket.id;
        userA.lastPartnerClientId = userB.clientId;
        
        userB.partnerId = userA.socket.id;
        userB.lastPartnerClientId = userA.clientId;

        if (userA.type === 'text') textWaitingPool = textWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        else if (userA.type === 'voice') voiceWaitingPool = voiceWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        else videoWaitingPool = videoWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);

        console.log(`✅ Matched: ${userA.nickname} <-> ${userB.nickname} | Interest: ${matchedInterest || 'None'}`);

        userA.socket.emit("partner-found", { 
            initiator: true, 
            partnerNickname: userB.nickname,
            commonInterests: matchedInterest ? [matchedInterest] : []
        });
        userB.socket.emit("partner-found", { 
            initiator: false, 
            partnerNickname: userA.nickname,
            commonInterests: matchedInterest ? [matchedInterest] : []
        });
    }
}

io.on("connection", socket => {
    console.log("🟢 Connected:", socket.id);
    
    users.set(socket.id, { 
        socket, 
        clientId: null,
        nickname: "Stranger", 
        partnerId: null, 
        lastPartnerClientId: null, 
        interests: [] 
    });
    updateOnlineCount();

    socket.on("latency-ping", (callback) => {
        if (typeof callback === "function") {
            callback();
        }
    });

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
        user.clientId = preferences.clientId; 
        
        user.interests = Array.isArray(preferences.interests) ? preferences.interests : [];
        
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

    socket.on("report-user", ({ reason }) => {
        const user = users.get(socket.id);
        if (!user) return;

        const targetClientId = user.lastPartnerClientId;
        if (!targetClientId || targetClientId === user.clientId) return;

        if (!clientBlocklists.has(user.clientId)) clientBlocklists.set(user.clientId, new Set());
        clientBlocklists.get(user.clientId).add(targetClientId);

        if (!clientBlocklists.has(targetClientId)) clientBlocklists.set(targetClientId, new Set());
        clientBlocklists.get(targetClientId).add(user.clientId);

        console.log(`🛡️ User ${user.clientId} blocked ${targetClientId}`);

        if (!reportLedger.has(targetClientId)) {
            reportLedger.set(targetClientId, { total: 0, reporters: new Set() });
        }
        const record = reportLedger.get(targetClientId);

        if (record.reporters.has(user.clientId)) return; 
        
        record.reporters.add(user.clientId);
        record.total += 1;
        console.log(`🚩 Report against Device ID ${targetClientId}. Total: ${record.total}`);

        if (record.total >= 2) {
            console.log(`🔨 Device ID ${targetClientId} BANNED.`);
            
            for (const [id, u] of users.entries()) {
                if (u.clientId === targetClientId) {
                    u.socket.emit("you-are-banned"); 
                    
                    if (u.partnerId) {
                        const theirPartner = users.get(u.partnerId);
                        if (theirPartner) {
                            theirPartner.partnerId = null;
                            theirPartner.socket.emit("partner-disconnected");
                        }
                    }
                    users.delete(id);
                    textWaitingPool = textWaitingPool.filter(pid => pid !== id);
                    voiceWaitingPool = voiceWaitingPool.filter(pid => pid !== id);
                    videoWaitingPool = videoWaitingPool.filter(pid => pid !== id);
                }
            }
            updateOnlineCount();
            reportLedger.delete(targetClientId);
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

    socket.on("typing", (isTyping) => {
        const user = users.get(socket.id);
        if (user?.partnerId) {
            const partner = users.get(user.partnerId);
            if (partner) partner.socket.emit("partner-typing", isTyping);
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
        user.partnerId = null;
    };

    socket.on("next", handleDisconnectOrNext);
    
    socket.on("disconnect", () => {
        handleDisconnectOrNext();
        users.delete(socket.id);
        updateOnlineCount();
    });
});
