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

// In-memory store
const users = new Map();  // socket.id → { socket, nickname, partnerId }
const queue = [];         // sockets waiting for partner

// === Helpers ===
function removeFromQueue(id) {
  const index = queue.indexOf(id);
  if (index !== -1) queue.splice(index, 1);
}

function tryMatch() {
  while (queue.length >= 2) {
    const id1 = queue.shift();
    const id2 = queue.shift();

    const u1 = users.get(id1);
    const u2 = users.get(id2);

    if (!u1 || !u2 || u1.partnerId || u2.partnerId) {
      if (u1 && !u1.partnerId) queue.push(id1);
      if (u2 && !u2.partnerId) queue.push(id2);
      continue;
    }

    // Pair them
    u1.partnerId = id2;
    u2.partnerId = id1;

    console.log(`🔗 Paired: ${id1} <--> ${id2}`);

    u1.socket.emit("peer-connected", {
      initiator: true,
      strangerNickname: u2.nickname
    });

    u2.socket.emit("peer-connected", {
      initiator: false,
      strangerNickname: u1.nickname
    });
  }
}

// === Socket.IO Events ===
io.on("connection", socket => {
  console.log("🟢 Connected:", socket.id);
  users.set(socket.id, { socket, nickname: "Stranger", partnerId: null });

  socket.on("set-nickname", nickname => {
    const user = users.get(socket.id);
    if (user) user.nickname = nickname;
  });

  socket.on("find-partner", () => {
    const user = users.get(socket.id);
    if (!user || user.partnerId) return;
    removeFromQueue(socket.id);
    queue.push(socket.id);
    console.log(`🕵️ Added to queue: ${socket.id}`);
    tryMatch();
  });

  socket.on("signal", data => {
    const user = users.get(socket.id);
    if (user?.partnerId) {
      const partner = users.get(user.partnerId);
      if (partner) {
        partner.socket.emit("signal", data);
      }
    }
  });

  socket.on("next", () => {
    const user = users.get(socket.id);
    if (!user) return;

    const partnerId = user.partnerId;
    if (partnerId && users.has(partnerId)) {
      const partner = users.get(partnerId);
      partner.partnerId = null;
      partner.socket.emit("disconnect-peer");
      removeFromQueue(partnerId);
      queue.push(partnerId);
      console.log(`🔁 ${socket.id} skipped partner ${partnerId}`);
    }

    user.partnerId = null;
    socket.emit("disconnect-peer");
    removeFromQueue(socket.id);
    queue.push(socket.id);
    tryMatch();
  });

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
    const user = users.get(socket.id);
    const partnerId = user?.partnerId;

    if (partnerId && users.has(partnerId)) {
      const partner = users.get(partnerId);
      partner.partnerId = null;
      partner.socket.emit("disconnect-peer");
      removeFromQueue(partnerId);
      queue.push(partnerId);
      console.log(`⚠️ Partner ${partnerId} re-queued because ${socket.id} disconnected`);
    }

    removeFromQueue(socket.id);
    users.delete(socket.id);
    tryMatch();
  });
});
