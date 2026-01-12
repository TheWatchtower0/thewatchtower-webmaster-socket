import url from "url";
import { WebSocketServer } from "ws";

const webSocketSecure = new WebSocketServer({
   port: process.env.PORT || 8080
});

const BACKEND_URL = process.env.BACKEND_URL || "https://watchtower.thewatchtower.ae/api";

/**
 * @type {Map<string, Set<WebSocket>>} - userId to set of WebSocket connections
 */
const userConnections = new Map();

/**
 * @type {Map<string, Set<WebSocket>>} - deviceId to set of WebSocket connections
 */
const deviceConnections = new Map();

/**
 * @type {Map<string, Set<WebSocket>>} - admin users connections
 */
const adminConnections = new Map();

/**
 * @type {Map<string, {conversation_user_id:string,conversation_admin_id:string}>}
 */
const conversationsMap = new Map();

webSocketSecure.on("connection", async (webSocket, request) => {
  const {
    deviceId,
    userId,
    isAdmin,
    conversationId,
    token,
    userOnWebmaster = "1",
  } = url.parse(request.url, true).query;

  const parsedIsAdmin = isAdmin === "true";
  const parsedUserOnWebmaster = userOnWebmaster === "1";

  // Store connection information
  webSocket.deviceId = deviceId;
  webSocket.userId = userId;
  webSocket.token = token;
  webSocket.isAdmin = parsedIsAdmin;
  webSocket.userOnWebmaster = parsedUserOnWebmaster;
  webSocket.conversationId = conversationId;
  webSocket.isAlive = true;

 // Add to device connections
  if (!deviceConnections.has(deviceId)) {
    deviceConnections.set(deviceId, new Set());
  }
  deviceConnections.get(deviceId).add(webSocket);

  // Add to appropriate connection map based on user type
  if (parsedIsAdmin) {
    // Admin user
    if (!adminConnections.has(userId)) {
      adminConnections.set(userId, new Set());
    }
    adminConnections.get(userId).add(webSocket);
    
    // Also track admins in userConnections for easy lookup when sending messages
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(webSocket);
  } else {
    // Regular user
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(webSocket);
  }
  const api = createApi(webSocket);
  const getChatMembers = createGetMembers(webSocket);
  const toggleUserOnlineStatus = createUserStatusToggler(webSocket);

  toggleUserOnlineStatus(true);

  if (webSocket.isAdmin) {
    await api.post("/messages/delivered-all", { sender_id: webSocket.userId });

    // Notify all other users that an admin is online
    broadcastToAllUsers({ type: "admin_login" }, [webSocket.userId]);
  } else {
    if (webSocket.userOnWebmaster) {
      await api.post("/messages/delivered-all", {
        sender_id: webSocket.userId,
      });
    } else {
      await api.post("/messages/read-all", {
        sender_id: webSocket.userId,
      });
    }

    // Notify all admins that a user logged in
    broadcastToAllAdmins({
      type: "user_login",
      conversation_id: webSocket.conversationId,
      user_on_webmaster: parsedUserOnWebmaster,
      user_id: webSocket.userId,
    });
  }

  webSocket.on("message", async (data) => {
    try {
      const json = JSON.parse(Buffer.from(data).toString());
      await handleMessage(json, webSocket, getChatMembers, api);
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  webSocket.on("close", () => {
    removeConnection(webSocket);
    toggleUserOnlineStatus(false);
  });

  webSocket.on("pong", () => {
    webSocket.isAlive = true;
    console.log(`Pong received from user ${userId}, device ${deviceId}`);
  });

  webSocket.on("error", (error) => {
    console.error(`WebSocket error for user ${userId}:`, error);
    removeConnection(webSocket);
  });
});

// Heartbeat interval to detect and remove dead connections
setInterval(() => {
  webSocketSecure?.clients.forEach((ws) => {
    const customWs = ws;
    if (customWs.isAlive === false) {
      console.log(
        `Terminating dead socket for user ${customWs.userId}, device ${customWs.deviceId}`
      );
      removeConnection(customWs);
      return customWs.terminate();
    }
    customWs.isAlive = false;
    customWs.ping();
  });
}, 15000);

async function handleMessage(json, webSocket, getChatMembers, api) {
  switch (json.type) {
    case "send_message":
      await handleSendMessage(json, webSocket, getChatMembers, api);
      break;

    case "delivered_message":
      await handleDeliveredMessage(json, webSocket, getChatMembers, api);
      break;

    case "read_message":
      await handleReadMessage(json, webSocket, getChatMembers, api);
      break;

    case "focus":
    case "active-typing":
    case "idle-typing":
    case "blur":
      await handleUserActivity(json, webSocket, getChatMembers);
      break;

    case "edit_message":
      await handleEditMessage(json, webSocket, getChatMembers, api);
      break;

    case "delete_message":
      await handleDeleteMessage(json, webSocket, getChatMembers, api);
      break;

    case "admin_open_chat":
      await handleAdminOpenChat(json, webSocket, getChatMembers, api);
      break;

    default:
      console.log("Unknown message type:", json.type);
      break;
  }
}

async function handleSendMessage(json, webSocket, getChatMembers, api) {
  const payload = {
    ...json,
    type: "message_sent",
    message: json.message,
    message_id: json.message_id,
    conversation_id: json.conversation_id,
    sender_id: webSocket.userId,
    time: json.time,
    deviceId: webSocket.deviceId,
  };

  await api.post("/messages/send", {
    message_id: payload.message_id,
    conversation_id: payload.conversation_id,
    message: payload.message,
    sender_id: payload.sender_id,
    time: payload.time,
    parent_id: payload.reply,
    sentFiles: payload.files,
  });

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  // Send to all connections of the user (all their devices)
  sendToUserConnections(members.conversation_user_id, payload, [
    webSocket.userId,
  ]);

  // Send to all connections of the admin (all admin devices)
  sendToUserConnections(members.conversation_admin_id, payload, [
    webSocket.userId,
  ]);

  // If sender is admin, also broadcast to all other admins
  if (webSocket.isAdmin) {
    broadcastToAllAdmins(payload, [webSocket.userId]);
  }
}

async function handleDeliveredMessage(json, webSocket, getChatMembers, api) {
  const payload = {
    type: "message_delivered",
    message_id: json.message_id,
    conversation_id: json.conversation_id,
    sender_id: webSocket.userId,
    deviceId: webSocket.deviceId,
  };

  await api.post("/messages/delivered", {
    message_id: payload.message_id,
    conversation_id: payload.conversation_id,
    sender_id: payload.sender_id,
  });

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  // Send to all connections of the user (all their devices)
  sendToUserConnections(members.conversation_user_id, payload);

  // Send to all connections of the admin (all admin devices)
  sendToUserConnections(members.conversation_admin_id, payload);
}

async function handleReadMessage(json, webSocket, getChatMembers, api) {
  const payload = {
    type: "message_read",
    conversation_id: json.conversation_id,
    sender_id: webSocket.userId,
    deviceId: webSocket.deviceId,
    message_id: json.message_id,
  };

  await api.post("/messages/read", {
    conversation_id: payload.conversation_id,
    sender_id: payload.sender_id,
    message_id: payload.message_id,
  });

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  sendToUserConnections(members.conversation_user_id, payload);
  sendToUserConnections(members.conversation_admin_id, payload);
}

async function handleUserActivity(json, webSocket, getChatMembers) {
  const payload = {
    type: json.type,
    conversation_id: json.conversation_id,
    sender_id: webSocket.userId,
    deviceId: webSocket.deviceId,
  };

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  sendToUserConnections(members.conversation_user_id, payload);
  sendToUserConnections(members.conversation_admin_id, payload);
}

async function handleEditMessage(json, webSocket, getChatMembers, api) {
  const payload = {
    type: "message_edited",
    message: json.message,
    message_id: json.message_id,
    conversation_id: json.conversation_id,
    sender_id: webSocket.userId,
    deviceId: webSocket.deviceId,
  };

  await api.post("/messages/update", {
    message: payload.message,
    message_id: payload.message,
  });

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  sendToUserConnections(members.conversation_user_id, payload);
  sendToUserConnections(members.conversation_admin_id, payload);
}

async function handleDeleteMessage(json, webSocket, getChatMembers, api) {
  const payload = {
    type: "message_deleted",
    message_id: json.message_id,
    conversation_id: json.conversation_id,
    deviceId: webSocket.deviceId,
  };

  await api.post("/messages/delete", {
    message_id: payload.message_id,
  });

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  sendToUserConnections(members.conversation_user_id, payload);
  sendToUserConnections(members.conversation_admin_id, payload);
}

async function handleAdminOpenChat(json, webSocket, getChatMembers, api) {
  const payload = {
    type: "admin_open_chat",
    conversation_id: json.conversation_id,
    sender_id: webSocket.userId,
    deviceId: webSocket.deviceId,
  };

  await api.post("/messages/read-all", {
    sender_id: webSocket.userId,
    conversation_id: payload.conversation_id,
  });

  const members = await getChatMembers(json.conversation_id);
  if (!members) return;

  sendToUserConnections(members.conversation_user_id, payload);
}

// Helper functions for broadcasting
function sendToUserConnections(userId, payload, excludeUserIds = []) {
  if (excludeUserIds.includes(userId)) return;

  const connections = userConnections.get(userId);
  if (connections) {
    connections.forEach((socket) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    });
  }
}

function broadcastToAllAdmins(payload, excludeUserIds = []) {
  adminConnections.forEach((connections, adminId) => {
    if (!excludeUserIds.includes(adminId)) {
      connections.forEach((socket) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      });
    }
  });
}

function broadcastToAllUsers(payload, excludeUserIds = []) {
  userConnections.forEach((connections, userId) => {
    if (!excludeUserIds.includes(userId)) {
      connections.forEach((socket) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      });
    }
  });
}

function removeConnection(webSocket) {
  const { userId, deviceId, isAdmin } = webSocket;

  // Remove from user connections
  if (userId && userConnections.has(userId)) {
    const userSockets = userConnections.get(userId);
    userSockets.delete(webSocket);
    if (userSockets.size === 0) {
      userConnections.delete(userId);
    }
  }

  // Remove from device connections
  if (deviceId && deviceConnections.has(deviceId)) {
    const deviceSockets = deviceConnections.get(deviceId);
    deviceSockets.delete(webSocket);
    if (deviceSockets.size === 0) {
      deviceConnections.delete(deviceId);
    }
  }

  // Remove from admin connections
  if (isAdmin && userId && adminConnections.has(userId)) {
    const adminSockets = adminConnections.get(userId);
    adminSockets.delete(webSocket);
    if (adminSockets.size === 0) {
      adminConnections.delete(userId);
    }
  }
}

function createGetMembers(ws) {
  const api = createApi(ws);
  return async function getConversationMembers(conversation_id) {
    if (conversationsMap.has(conversation_id)) {
      return conversationsMap.get(conversation_id);
    } else {
       try {
        const response = await api.get(`/messages/conversation/${conversation_id}`);
        
        // 1. Check if the response is actually JSON
        const contentType = response.headers.get("content-type");
        
        if (contentType && contentType.includes("application/json")) {
          const data = await response.json();
          
          if (data.status) {
            const payload = {
              conversation_user_id: String(data.data?.conversation_user_id),
              conversation_admin_id: String(data.data?.conversation_admin_id),
            };
            conversationsMap.set(conversation_id, payload);
            return payload;
          }
        } else {
          // 2. Handle HTML or plain text response
          const textError = await response.text();
          console.warn("Received non-JSON response:", textError);
          throw new Error(`Server returned ${response.status} (HTML/Text)`);
        }
      
      } catch (error) {
        // 3. Robust Error Logging
        if (error instanceof SyntaxError) {
          console.error("JSON Parsing failed. The server likely sent HTML.");
        } else {
          console.error("Request Error:", error.message);
        }
      }
    }
  };
}

function createUserStatusToggler(ws) {
  const api = createApi(ws);
  return async function toggleUserOnlineStatus(status) {
    try {
      api.get(`/admin/user/status/${ws.userId}`, {
        is_online: JSON.stringify(status),
      });
    } catch (error) {
      console.log(error);
    }
  };
}

function createApi(ws) {
  return {
    async get(url, params = {}) {
      const queryString = new URLSearchParams(params).toString();
      const urlWithParams = queryString ? `${url}?${queryString}` : url;
      return await fetch(`${BACKEND_URL}${urlWithParams}`, {
        method: "GET",
        headers: {
          "Content-type": "application/json",
          Authorization: `Bearer ${ws.token}`,
        },
      });
    },
    async post(url, payload) {
      return await fetch(`${BACKEND_URL}${url}`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          "Content-type": "application/json",
          Authorization: `Bearer ${ws.token}`,
        },
      });
    },
  };
}

console.log(`WebSocket server is running on port ${process.env.PORT || 8080}`);








