const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const path = require("path");

const io = new Server(http, {
  cors: {
    origin: "*", // It's recommended to change this to your specific URL for production
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;
app.use(express.static(path.join(__dirname, "public")));

http.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const users = new Map();
// ✨ NEW: Two separate waiting pools for chat and voice
let textWaitingPool = [];
let voiceWaitingPool = [];

function findMatch(newUserSocketId) {
    const userA = users.get(newUserSocketId);
    if (!userA || userA.partnerId) return;

    // Determine which pool to search in based on the user's selected type
    const pool = userA.type === 'text' ? textWaitingPool : voiceWaitingPool;

    const partnerId = pool.find(id => {
        if (id === newUserSocketId) return false;
        const userB = users.get(id);
        if (!userB || userB.partnerId) return false;

        const aWantsB = userA.lookingFor === 'anyone' || userA.lookingFor === userB.gender;
        const bWantsA = userB.lookingFor === 'anyone' || userB.lookingFor === userA.gender;

        return aWantsB && bWantsA;
    });

    if (partnerId) {
        const userB = users.get(partnerId);
        
        userA.partnerId = userB.socket.id;
        userB.partnerId = userA.socket.id;

        // Remove both users from the correct waiting pool
        if (userA.type === 'text') {
            textWaitingPool = textWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        } else {
            voiceWaitingPool = voiceWaitingPool.filter(id => id !== newUserSocketId && id !== partnerId);
        }
        
        console.log(`✅ Matched (${userA.type}): ${userA.nickname} <-> ${userB.nickname}`);

        // Let both clients know a partner was found and what type of connection it is
        userA.socket.emit("partner-found", { initiator: true, partnerNickname: userB.nickname, type: userA.type });
        userB.socket.emit("partner-found", { initiator: false, partnerNickname: userA.nickname, type: userB.type });
    }
}

io.on("connection", socket => {
  console.log("🟢 Connected:", socket.id);
  users.set(socket.id, { socket, nickname: "Stranger", partnerId: null });

  socket.on("set-nickname", nickname => {
    const user = users.get(socket.id);
    if (user) user.nickname = nickname;
  });

  socket.on("find-partner", (preferences) => {
    const user = users.get(socket.id);
    if (!user || user.partnerId) return;

    // Store user's preferences and the type of connection they want
    user.gender = preferences.gender;
    user.lookingFor = preferences.lookingFor;
    user.type = preferences.type; // 'text' or 'voice'

    // Add user to the correct waiting pool
    const pool = user.type === 'text' ? textWaitingPool : voiceWaitingPool;
    if (!pool.includes(socket.id)) {
        pool.push(socket.id);
    }
    
    console.log(`🔎 ${user.nickname} is looking for a ${user.type} partner. Pools: Text[${textWaitingPool.length}], Voice[${voiceWaitingPool.length}]`);
    findMatch(socket.id);
  });
  
  // For Voice Chat Signaling
  socket.on("signal", data => {
    const user = users.get(socket.id);
    if (user?.partnerId) {
      const partner = users.get(user.partnerId);
      if (partner) partner.socket.emit("signal", data);
    }
  });

  // ✨ NEW: For Text Chat Messages
  socket.on("send-message", ({ message }) => {
    const user = users.get(socket.id);
    if (user?.partnerId) {
      const partner = users.get(user.partnerId);
      if (partner) partner.socket.emit("receive-message", { message });
    }
  });

  const handleDisconnectOrNext = () => {
      const user = users.get(socket.id);
      if (!user) return;

      // Remove user from both pools just in case
      textWaitingPool = textWaitingPool.filter(id => id !== socket.id);
      voiceWaitingPool = voiceWaitingPool.filter(id => id !== socket.id);

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
  });
});
