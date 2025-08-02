const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
const path = require("path");

const PORT = process.env.PORT || 5000;
app.use(express.static(path.join(__dirname, "public")));

http.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// --- Data Store ---
const users = new Map(); // socket.id → { socket, nickname, gender, lookingFor, partnerId }
let waitingPool = []; // Array of socket.ids waiting for a partner

// --- Matchmaking Logic ---
function findMatch(newUserSocketId) {
    const userA = users.get(newUserSocketId);
    if (!userA || userA.partnerId) return; // Exit if user is invalid or already in a call

    // Find a compatible partner from the waiting pool
    const partnerIndex = waitingPool.findIndex(id => {
        if (id === newUserSocketId) return false; // Can't match with self
        const userB = users.get(id);
        if (!userB || userB.partnerId) return false; // Partner is invalid or already in a call

        // Check for a two-way match
        const aWantsB = userA.lookingFor === 'anyone' || userA.lookingFor === userB.gender;
        const bWantsA = userB.lookingFor === 'anyone' || userB.lookingFor === userA.gender;

        return aWantsB && bWantsA;
    });

    if (partnerIndex !== -1) {
        // --- We have a match! ---
        const userBSocketId = waitingPool[partnerIndex];
        const userB = users.get(userBSocketId);
        
        userA.partnerId = userB.socket.id;
        userB.partnerId = userA.socket.id;

        // Remove both users from the waiting pool
        waitingPool.splice(partnerIndex, 1); // Remove partner
        const newUserIndex = waitingPool.indexOf(newUserSocketId);
        if (newUserIndex !== -1) waitingPool.splice(newUserIndex, 1); // Remove new user
        
        console.log(`✅ Matched: ${userA.nickname} (${userA.gender}) <-> ${userB.nickname} (${userB.gender})`);

        // Notify clients to connect via WebRTC
        userA.socket.emit("peer-connected", { initiator: true, strangerNickname: userB.nickname });
        userB.socket.emit("peer-connected", { initiator: false, strangerNickname: userA.nickname });
    }
}


// --- Socket.IO Events ---
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

    user.gender = preferences.gender;
    user.lookingFor = preferences.lookingFor;
    
    if (!waitingPool.includes(socket.id)) {
        waitingPool.push(socket.id);
    }
    
    console.log(`🔎 ${user.nickname} (${user.gender}) is looking for ${user.lookingFor}. Pool size: ${waitingPool.length}`);
    findMatch(socket.id);
  });
  
  socket.on("signal", data => {
    const user = users.get(socket.id);
    if (user?.partnerId) {
      const partner = users.get(user.partnerId);
      if (partner) partner.socket.emit("signal", data);
    }
  });

  const handleDisconnectOrNext = () => {
      const user = users.get(socket.id);
      if (!user) return;

      // Remove user from waiting pool
      const poolIndex = waitingPool.indexOf(socket.id);
      if (poolIndex !== -1) waitingPool.splice(poolIndex, 1);

      const partnerId = user.partnerId;
      if (partnerId) {
          const partner = users.get(partnerId);
          if (partner) {
              partner.partnerId = null;
              partner.socket.emit("disconnect-peer");
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
