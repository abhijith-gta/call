// === Socket.IO ===
const socket = io();

// === State ===
let peer = null;
let localStream = null;
let callStartTime = null;
let timerInterval = null;
let isManuallyEnded = false;

// === UI Elements ===
const nicknameScreen = document.getElementById("nicknameScreen");
const chatScreen = document.getElementById("call-screen");
const nicknameInput = document.getElementById("nicknameInput");

const callerName = document.getElementById("caller-name");
const statusMessage = document.getElementById("status-message");
const callTimer = document.getElementById("call-timer");

const startButton = document.getElementById("startButton");
const nextButton = document.getElementById("nextButton");
const endButton = document.getElementById("endButton");
const muteButton = document.getElementById("muteBtn");
const remoteAudio = document.getElementById("remoteAudio");

// === Microphone Access ===
navigator.mediaDevices.getUserMedia({ audio: true })
  .then((stream) => {
    localStream = stream;
  })
  .catch((err) => {
    alert("Microphone access denied");
    console.error("Mic error:", err);
  });

// === Helper Functions ===
function showChatScreen() {
  nicknameScreen.classList.remove("active");
  chatScreen.classList.add("active");
  window.scrollTo(0, 0); // Ensure top on mobile
}

function cleanupPeer() {
  stopTimer();
  if (peer) {
    peer.destroy();
    peer = null;
  }
  callerName.textContent = "Stranger"; // Clear old stranger name
  statusMessage.textContent = "❌ Disconnected";
  remoteAudio.srcObject = null; // Stop remote audio
  // Reset mute icon
  if (localStream && localStream.getAudioTracks()[0].enabled) {
    muteButton.textContent = "🔇";
  } else {
    muteButton.textContent = "🔊";
  }
}

function startTimer() {
  callStartTime = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const seconds = Math.floor((Date.now() - callStartTime) / 1000);
    callTimer.textContent = `⏱ ${seconds}s`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  callTimer.textContent = "00:00";
}

function createPeer(initiator) {
  peer = new SimplePeer({
    initiator,
    stream: localStream,
    trickle: false,
  });

  peer.on("signal", (data) => socket.emit("signal", data));

  peer.on("connect", () => {
    statusMessage.textContent = "✅ Connected";
    startTimer();
    if ("vibrate" in navigator) navigator.vibrate(200); // Vibrate on connect
  });

  peer.on("stream", (stream) => {
    remoteAudio.srcObject = stream;
    remoteAudio.play().catch((e) => console.warn("Playback failed:", e));
  });

  peer.on("close", () => {
    cleanupPeer();
  });

  peer.on("error", (err) => {
    console.error("Peer error:", err);
    cleanupPeer();
    socket.emit("next");
  });
}

// === Button Handlers ===
startButton.onclick = () => {
  const nickname = nicknameInput.value.trim() || "Anonymous";
  socket.emit("set-nickname", nickname);
  showChatScreen();
  isManuallyEnded = false;
  statusMessage.textContent = "🔁 Searching for a partner...";
  socket.emit("find-partner");
};

nextButton.onclick = () => {
  isManuallyEnded = true;
  cleanupPeer();
  statusMessage.textContent = "🔁 Searching for a new partner...";
  socket.emit("next");
};

endButton.onclick = () => {
  isManuallyEnded = true;
  cleanupPeer();
  statusMessage.textContent = "🔁 Searching for a partner...";
  socket.emit("find-partner");
};

muteButton.onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  muteButton.textContent = track.enabled ? "🔇" : "🔊";
};

// === Socket Events ===
socket.on("peer-connected", ({ initiator, strangerNickname }) => {
  callerName.textContent = strangerNickname || "Stranger";
  statusMessage.textContent = "🔗 Connecting...";
  createPeer(initiator);
});

socket.on("signal", (data) => {
  try {
    if (peer) peer.signal(data);
  } catch (e) {
    console.error("Signal error:", e);
  }
});

socket.on("disconnect-peer", () => {
  cleanupPeer();
  if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]); // Vibrate on disconnect
  if (!isManuallyEnded) {
    statusMessage.textContent = "❌ Partner left. Re-searching...";
    setTimeout(() => socket.emit("find-partner"), 500);
  }
});
