const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

let db;
const DB_PATH_PRIMARY = "/var/data/chat.db";
const DB_PATH_FALLBACK = path.join(__dirname, "chat.db");

function initDatabase() {
  let dbPath;
  try {
    if (!fs.existsSync("/var/data/"))
      fs.mkdirSync("/var/data/", { recursive: true });
    dbPath = DB_PATH_PRIMARY;
  } catch (e) {
    dbPath = DB_PATH_FALLBACK;
  }

  const Database = require("better-sqlite3");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      handle TEXT NOT NULL,
      emoji TEXT NOT NULL,
      UNIQUE(message_id, handle, emoji)
    );
  `);

  try {
    db.exec(
      `ALTER TABLE users ADD COLUMN joined_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
    );
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to INTEGER DEFAULT NULL`);
  } catch (e) {}

  const count = db.prepare("SELECT COUNT(*) as cnt FROM users").get();
  if (count.cnt === 0) {
    const hashed = bcrypt.hashSync("adminPassword123", 10);
    db.prepare(
      "INSERT INTO users (handle, password, is_admin, status) VALUES (?, ?, 1, 'approved')",
    ).run("admin", hashed);
    console.log("[DB] Seeded admin: admin / adminPassword123");
  }
  console.log(`[DB] SQLite at: ${dbPath}`);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();
const socketSessions = new Map();
const onlineUsers = new Map(); // handle -> { socketId, joinedAt }

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}
function getSessionFromToken(token) {
  return sessions.get(token) || null;
}

app.post("/api/register", (req, res) => {
  const { handle, password } = req.body;
  if (!handle || !password)
    return res.status(400).json({ error: "Handle and password required." });
  if (handle.length < 3 || handle.length > 20)
    return res.status(400).json({ error: "Handle must be 3-20 characters." });
  if (password.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters." });
  if (!/^[a-zA-Z0-9_]+$/.test(handle))
    return res
      .status(400)
      .json({
        error: "Handle can only contain letters, numbers, and underscores.",
      });
  if (db.prepare("SELECT id FROM users WHERE handle = ?").get(handle))
    return res.status(409).json({ error: "That handle is already taken." });
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare(
    "INSERT INTO users (handle, password, is_admin, status) VALUES (?, ?, 0, 'pending')",
  ).run(handle, hashed);
  res.json({ message: "Registration submitted. Awaiting admin approval." });
});

app.post("/api/login", (req, res) => {
  const { handle, password } = req.body;
  if (!handle || !password)
    return res.status(400).json({ error: "Handle and password required." });
  const user = db.prepare("SELECT * FROM users WHERE handle = ?").get(handle);
  if (!user)
    return res.status(401).json({ error: "Invalid handle or password." });
  if (!bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: "Invalid handle or password." });
  if (user.status === "pending")
    return res
      .status(403)
      .json({ error: "Your account is pending admin approval." });
  if (user.status === "rejected")
    return res
      .status(403)
      .json({ error: "Your registration has been rejected." });
  const token = generateToken();
  sessions.set(token, {
    userId: user.id,
    handle: user.handle,
    isAdmin: user.is_admin,
  });
  res.json({
    token,
    handle: user.handle,
    isAdmin: user.is_admin,
    joinedAt: user.joined_at,
  });
});

app.post("/api/logout", (req, res) => {
  const token = req.headers["x-session-token"];
  if (token) sessions.delete(token);
  res.json({ message: "Logged out." });
});

app.get("/api/admin/pending", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session || !session.isAdmin)
    return res.status(403).json({ error: "Forbidden." });
  res.json(
    db
      .prepare("SELECT id, handle, status FROM users WHERE status = 'pending'")
      .all(),
  );
});

app.get("/api/admin/users", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session || !session.isAdmin)
    return res.status(403).json({ error: "Forbidden." });
  res.json(
    db
      .prepare(
        "SELECT id, handle, status FROM users WHERE is_admin = 0 ORDER BY status, handle",
      )
      .all(),
  );
});

app.post("/api/admin/users/:id/status", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session || !session.isAdmin)
    return res.status(403).json({ error: "Forbidden." });
  const { status } = req.body;
  if (!["approved", "rejected"].includes(status))
    return res.status(400).json({ error: "Invalid status." });
  const userId = parseInt(req.params.id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  if (status === "rejected") {
    for (const [tok, sess] of sessions.entries()) {
      if (sess.handle === user.handle) sessions.delete(tok);
    }
  }
  io.emit("admin:user_status_changed", { handle: user.handle, status });
  res.json({ message: `User ${user.handle} has been ${status}.` });
});

app.delete("/api/admin/users/:id", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session || !session.isAdmin)
    return res.status(403).json({ error: "Forbidden." });
  const userId = parseInt(req.params.id);
  const user = db
    .prepare("SELECT * FROM users WHERE id = ? AND is_admin = 0")
    .get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  for (const [tok, sess] of sessions.entries()) {
    if (sess.handle === user.handle) sessions.delete(tok);
  }
  db.prepare("DELETE FROM reactions WHERE handle = ?").run(user.handle);
  db.prepare("DELETE FROM messages WHERE handle = ?").run(user.handle);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  io.emit("admin:user_removed", { handle: user.handle });
  res.json({ message: `User ${user.handle} has been removed.` });
});

app.post("/api/change-password", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session) return res.status(401).json({ error: "Unauthorized." });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "Both passwords required." });
  if (newPassword.length < 6)
    return res
      .status(400)
      .json({ error: "New password must be at least 6 characters." });
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(session.userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (!bcrypt.compareSync(currentPassword, user.password))
    return res.status(401).json({ error: "Current password is incorrect." });
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(
    bcrypt.hashSync(newPassword, 10),
    session.userId,
  );
  res.json({ message: "Password changed successfully." });
});

app.get("/api/messages", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session) return res.status(401).json({ error: "Unauthorized." });
  const messages = db
    .prepare(
      "SELECT id, handle, content, reply_to, created_at FROM messages ORDER BY id DESC LIMIT 100",
    )
    .all()
    .reverse();
  const msgIds = messages.map((m) => m.id);
  let reactions = [];
  if (msgIds.length > 0) {
    reactions = db
      .prepare(
        `SELECT message_id, emoji, handle FROM reactions WHERE message_id IN (${msgIds.map(() => "?").join(",")})`,
      )
      .all(...msgIds);
  }
  const rMap = {};
  reactions.forEach((r) => {
    if (!rMap[r.message_id]) rMap[r.message_id] = {};
    if (!rMap[r.message_id][r.emoji]) rMap[r.message_id][r.emoji] = [];
    rMap[r.message_id][r.emoji].push(r.handle);
  });
  // Build id->msg map for reply previews
  const msgMap = {};
  messages.forEach((m) => (msgMap[m.id] = m));
  const result = messages.map((m) => ({
    ...m,
    reactions: rMap[m.id] || {},
    reply_preview:
      m.reply_to && msgMap[m.reply_to]
        ? {
            handle: msgMap[m.reply_to].handle,
            content: msgMap[m.reply_to].content.substring(0, 80),
          }
        : null,
  }));
  res.json(result);
});

app.post("/api/admin/clear-chat", (req, res) => {
  const session = getSessionFromToken(req.headers["x-session-token"]);
  if (!session || !session.isAdmin)
    return res.status(403).json({ error: "Forbidden." });
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM reactions");
  io.emit("chat:cleared", { by: session.handle });
  res.json({ message: "Chat cleared." });
});

io.on("connection", (socket) => {
  socket.on("auth", (token) => {
    const session = getSessionFromToken(token);
    if (!session) {
      socket.emit("auth:error", "Invalid session. Please log in again.");
      socket.disconnect(true);
      return;
    }
    socketSessions.set(socket.id, {
      token,
      handle: session.handle,
      isAdmin: session.isAdmin,
    });
    onlineUsers.set(session.handle, {
      socketId: socket.id,
      joinedAt: new Date().toISOString(),
    });
    socket.emit("auth:ok", {
      handle: session.handle,
      isAdmin: session.isAdmin,
    });
    broadcastOnlineUsers();
  });

  socket.on("chat:message", (payload) => {
    const socketData = socketSessions.get(socket.id);
    if (!socketData) return socket.emit("error", "Not authenticated.");
    const session = getSessionFromToken(socketData.token);
    if (!session) {
      socket.emit("error", "Session expired.");
      socket.disconnect(true);
      return;
    }

    // Support both old string format and new object format
    let content, replyTo;
    if (typeof payload === "string") {
      content = payload;
      replyTo = null;
    } else {
      content = payload.content;
      replyTo = payload.replyTo || null;
    }

    if (typeof content !== "string" || content.trim().length === 0) return;
    const sanitized = content.trim().substring(0, 1000);
    const replyToId = replyTo ? parseInt(replyTo) : null;

    let replyMsg = null;
    if (replyToId) {
      replyMsg = db
        .prepare("SELECT id, handle, content FROM messages WHERE id = ?")
        .get(replyToId);
    }

    const result = db
      .prepare(
        "INSERT INTO messages (handle, content, reply_to) VALUES (?, ?, ?)",
      )
      .run(session.handle, sanitized, replyToId);
    const newMsg = {
      id: result.lastInsertRowid,
      handle: session.handle,
      content: sanitized,
      reply_to: replyToId,
      reply_preview: replyMsg
        ? {
            handle: replyMsg.handle,
            content: replyMsg.content.substring(0, 80),
          }
        : null,
      created_at: new Date().toISOString(),
      reactions: {},
    };
    io.emit("chat:message", newMsg);
  });

  socket.on("chat:react", ({ messageId, emoji }) => {
    const socketData = socketSessions.get(socket.id);
    if (!socketData) return;
    const session = getSessionFromToken(socketData.token);
    if (!session) return;
    const allowed = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
    if (!allowed.includes(emoji)) return;
    const existing = db
      .prepare(
        "SELECT id FROM reactions WHERE message_id = ? AND handle = ? AND emoji = ?",
      )
      .get(messageId, session.handle, emoji);
    if (existing) {
      db.prepare("DELETE FROM reactions WHERE id = ?").run(existing.id);
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO reactions (message_id, handle, emoji) VALUES (?, ?, ?)",
      ).run(messageId, session.handle, emoji);
    }
    const reactions = db
      .prepare("SELECT emoji, handle FROM reactions WHERE message_id = ?")
      .all(messageId);
    const grouped = {};
    reactions.forEach((r) => {
      if (!grouped[r.emoji]) grouped[r.emoji] = [];
      grouped[r.emoji].push(r.handle);
    });
    io.emit("chat:reactions_updated", { messageId, reactions: grouped });
  });

  socket.on("disconnect", () => {
    const socketData = socketSessions.get(socket.id);
    if (socketData) {
      onlineUsers.delete(socketData.handle);
      socketSessions.delete(socket.id);
      broadcastOnlineUsers();
    }
  });
});

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.entries()).map(([handle, info]) => ({
    handle,
    joinedAt: info.joinedAt,
  }));
  io.emit("users:online", users);
}

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
initDatabase();
server.listen(PORT, () =>
  console.log(`[Server] Running on http://localhost:${PORT}`),
);
