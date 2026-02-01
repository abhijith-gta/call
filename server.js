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

// Helper: Broadcast online count to all users
const updateOnlineCount = () => {
    const count = users.size;
    io.emit("online-count", count);
};

function findMatch(newUserSocketId) {
    const userA = users.get(newUserSocketId);
    if (!userA || userA.partnerId) return;

    // Determine which pool to search in (Text vs Voice)
    const pool = userA.type === 'text' ? textWaitingPool : voiceWaitingPool;

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
    // If userA has interests, try to find a candidate who shares at least one
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
    // If no interest match was found (or user had no interests), pick the first valid candidate
    if (!partnerId) {
        partnerId = candidates[0];
    }

    if (partnerId) {
        const userB = users.get(partnerId);

        // Link them together
        userA.partnerId = userB.socket.id;
        userB.partnerId = userA.socket.id;

        // Remove both users from the pool immediately
        if (userA.type === 'text') {
            textWaitingPool = textWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        } else {
            voiceWaitingPool = voiceWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        }

        console.log(`✅ Matched (${userA.type}): ${userA.nickname} <-> ${userB.nickname} ${commonInterests.length ? `[Tags: ${commonInterests}]` : ''}`);

        // Notify both users (Send common interests so frontend can display them)
        userA.socket.emit("partner-found", { initiator: true, partnerNickname: userB.nickname, type: userA.type, commonInterests });
        userB.socket.emit("partner-found", { initiator: false, partnerNickname: userA.nickname, type: userB.type, commonInterests });
    }
}

io.on("connection", socket => {
    console.log("🟢 Connected:", socket.id);
    // Initialize user with empty interests
    users.set(socket.id, { socket, nickname: "Stranger", partnerId: null, interests: [] });
    updateOnlineCount();

    socket.on("set-nickname", nickname => {
        const user = users.get(socket.id);
        if (user) user.nickname = sanitize(nickname).substring(0, 20);
    });

    // ✨ Updated: find-partner now accepts interests
    socket.on("find-partner", (preferences) => {
        const user = users.get(socket.id);
        if (!user || user.partnerId) return;

        user.gender = preferences.gender;
        user.lookingFor = preferences.lookingFor;
        user.type = preferences.type;
        
        // Store interests as lowercase array for matching
        user.interests = Array.isArray(preferences.interests) 
            ? preferences.interests.map(i => sanitize(i).toLowerCase().trim()).filter(i => i.length > 0)
            : [];

        // Add to the correct pool
        const pool = user.type === 'text' ? textWaitingPool : voiceWaitingPool;
        if (!pool.includes(socket.id)) {
            pool.push(socket.id);
        }

        console.log(`🔎 ${user.nickname} searching (${user.type})... Tags: [${user.interests.join(', ')}]`);
        findMatch(socket.id);
    });

    // 3. Voice Signaling
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

    // ✨ NEW: Latency Ping (For Signal Strength)
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