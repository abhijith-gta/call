const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const path = require("path");

// 1. Security: Basic HTML sanitization to prevent XSS attacks
const sanitize = (str) => {
    if (!str) return "";
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
};

const io = new Server(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;
app.use(express.static(path.join(__dirname, "public")));

http.listen(PORT, () => {
    console.log(`🚀 SwapLoop Server running on port ${PORT}`);
});

// State Management
const users = new Map();
let textWaitingPool = [];
let voiceWaitingPool = [];
let videoWaitingPool = []; // ✨ NEW: Video Call Pool

// Helper: Broadcast online count to all users
const updateOnlineCount = () => {
    const count = users.size;
    io.emit("online-count", count);
};

function findMatch(newUserSocketId) {
    const userA = users.get(newUserSocketId);
    if (!userA || userA.partnerId) return;

    // Determine which pool to search in (Text vs Voice vs Video)
    let pool;
    if (userA.type === 'text') pool = textWaitingPool;
    else if (userA.type === 'voice') pool = voiceWaitingPool;
    else pool = videoWaitingPool; // ✨ NEW: Video pool selection

    // 1. Filter: Find all valid candidates based on Gender & LookingFor
    const candidates = pool.filter(id => {
        if (id === newUserSocketId) return false;
        const userB = users.get(id);
        if (!userB || userB.partnerId) return false;

        const aWantsB = userA.lookingFor === 'anyone' || userA.lookingFor === userB.gender;
        const bWantsA = userB.lookingFor === 'anyone' || userB.lookingFor === userA.gender;

        return aWantsB && bWantsA;
    });

    if (candidates.length === 0) return;

    let partnerId = null;
    let commonInterests = [];

    // 2. Priority: Interest Matching
    if (userA.interests && userA.interests.length > 0) {
        const interestMatch = candidates.find(id => {
            const userB = users.get(id);
            if (!userB.interests || userB.interests.length === 0) return false;
            
            // Check for overlap
            const overlap = userA.interests.filter(tag => userB.interests.includes(tag));
            if (overlap.length > 0) {
                commonInterests = overlap;
                return true;
            }
            return false;
        });

        if (interestMatch) partnerId = interestMatch;
    }

    // 3. Fallback: Random Stranger
    if (!partnerId) {
        partnerId = candidates[0];
    }

    if (partnerId) {
        const userB = users.get(partnerId);

        // Link them together
        userA.partnerId = userB.socket.id;
        userB.partnerId = userA.socket.id;

        // Remove both users from the specific pool immediately
        if (userA.type === 'text') {
            textWaitingPool = textWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        } else if (userA.type === 'voice') {
            voiceWaitingPool = voiceWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        } else if (userA.type === 'video') {
            videoWaitingPool = videoWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId); // ✨ NEW: Video pool cleanup
        }

        console.log(`✅ Matched (${userA.type}): ${userA.nickname} <-> ${userB.nickname} ${commonInterests.length ? `[Tags: ${commonInterests}]` : ''}`);

        // Notify both users
        userA.socket.emit("partner-found", { initiator: true, partnerNickname: userB.nickname, type: userA.type, commonInterests });
        userB.socket.emit("partner-found", { initiator: false, partnerNickname: userA.nickname, type: userB.type, commonInterests });
    }
}

io.on("connection", socket => {
    console.log("🟢 Connected:", socket.id);
    users.set(socket.id, { socket, nickname: "Stranger", partnerId: null, interests: [] });
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
        
        user.interests = Array.isArray(preferences.interests) 
            ? preferences.interests.map(i => sanitize(i).toLowerCase().trim()).filter(i => i.length > 0)
            : [];

        // Add to the correct pool based on type
        let pool;
        if (user.type === 'text') pool = textWaitingPool;
        else if (user.type === 'voice') pool = voiceWaitingPool;
        else pool = videoWaitingPool; // ✨ NEW: Assign to Video pool

        if (!pool.includes(socket.id)) {
            pool.push(socket.id);
        }

        console.log(`🔎 ${user.nickname} searching (${user.type})... Tags: [${user.interests.join(', ')}]`);
        findMatch(socket.id);
    });

    // 3. Voice & Video Signaling (WebRTC)
    socket.on("signal", data => {
        const user = users.get(socket.id);
        if (user?.partnerId) {
            const partner = users.get(user.partnerId);
            if (partner) partner.socket.emit("signal", data);
        }
    });

    // --- Text Chat Features ---
    socket.on("send-message", ({ message }) => {
        const user = users.get(socket.id);
        if (user?.partnerId) {
            const partner = users.get(user.partnerId);
            if (partner) {
                partner.socket.emit("receive-message", { message: sanitize(message) });
            }
        }
    });

    // 4. Typing Indicators
    socket.on("typing", (isTyping) => {
        const user = users.get(socket.id);
        if (user?.partnerId) {
            const partner = users.get(user.partnerId);
            if (partner) partner.socket.emit("partner-typing", isTyping);
        }
    });

    socket.on("latency-ping", (callback) => {
        if (typeof callback === 'function') callback();
    });

    // --- Disconnect / Next Logic ---
    const handleDisconnectOrNext = () => {
        const user = users.get(socket.id);
        if (!user) return;

        // Clean up pools
        textWaitingPool = textWaitingPool.filter(id => id !== socket.id);
        voiceWaitingPool = voiceWaitingPool.filter(id => id !== socket.id);
        videoWaitingPool = videoWaitingPool.filter(id => id !== socket.id); // ✨ NEW: Remove from video pool on disconnect

        // Notify partner
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
        console.log("🔴 Disconnected:", socket.id);
        handleDisconnectOrNext();
        users.delete(socket.id);
        updateOnlineCount();
    });
});
