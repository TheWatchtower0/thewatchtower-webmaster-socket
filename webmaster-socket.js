import url from "url";
import { WebSocketServer } from "ws";

const webSocketSecure = new WebSocketServer({
  port: process.env.PORT || 8080,
});

// const BACKEND_URL = "https://fdd.thewatchtower.ae/api/v1";

/**
 * @type {Map<string, WebSocket>}
 */
const clients = new Map();
/**
 * @type {Map<string, WebSocket>}
 */
const deviceMap = new Map();
/**
 * @type {Map<string, {conversation_user_id:string,conversation_admin_id:string}>}
 */
const conversationsMap = new Map();

webSocketSecure.on("connection", async (webSocket, request) => {
  const { deviceId, userId } = url.parse(request.url, true).query;

  webSocket.deviceId = deviceId;
  webSocket.userId = userId;

  clients.set(userId, webSocket);
  deviceMap.set(deviceId, webSocket);

  webSocket.on("message", async (data) => {
    const json = JSON.parse(Buffer.from(data).toString());

    switch (json.type) {
      case "send_message":
        {
          const payload = {
            ...json,
            type: "message_sent",
            message: json.message,
            read: false,
            message_id: json.message_id,
            conversation_id: json.conversation_id,
            sender_id: json.sender_id,
            time: json.time,
            deviceId: webSocket.deviceId,
            ...(json.reply && { reply: json.reply }),
          };

          const response = await fetch(`${BACKEND_URL}/messages/send`, {
            method: "POST",
            body: JSON.stringify({
              message_id: payload.message_id,
              conversation_id: payload.conversation_id,
              message: payload.message,
              sender_id: payload.sender_id,
              time: payload.time,
              ...(payload.reply && { parent_id: payload.reply.id }),
              ...(payload.sentFiles && { sentFiles: payload.sentFiles }),
            }),
            headers: {
              "content-type": "application/json",
            },
          });

          const data = await response.json();

          const involvedSockets = [
            clients.get(data.data.conversation_user_id.toString()),
            clients.get(data.data.conversation_admin_id.toString()),
          ];

          involvedSockets.forEach((socket) => {
            socket &&
              socket.readyState === socket.OPEN &&
              socket?.send(JSON.stringify(payload));
          });
        }
        break;
      case "delivered_message":
        {
          const payload = {
            type: "message_delivered",
            message_id: json.message_id,
            conversation_id: json.conversation_id,
            sender_id: json.sender_id,
            deviceId: webSocket.deviceId,
          };

          const response = await fetch(`${BACKEND_URL}/messages/delivered`, {
            method: "POST",
            body: JSON.stringify({
              message_id: payload.message_id,
              conversation_id: payload.conversation_id,
              sender_id: payload.sender_id,
            }),
            headers: {
              "content-type": "application/json",
            },
          });

          const data = await response.json();

          const involvedSockets = [
            clients.get(data.data.conversation_user_id.toString()),
            clients.get(data.data.conversation_admin_id.toString()),
          ];

          involvedSockets.forEach((socket) => {
            socket &&
              socket.readyState === socket.OPEN &&
              socket?.send(JSON.stringify(payload));
          });
        }
        break;
      case "read_message":
        {
          const payload = {
            type: "message_read",
            conversation_id: json.conversation_id,
            sender_id: json.sender_id,
            deviceId: webSocket.deviceId,
          };

          const response = await fetch(`${BACKEND_URL}/messages/read-all`, {
            method: "POST",
            body: JSON.stringify({
              conversation_id: payload.conversation_id,
              sender_id: payload.sender_id,
            }),
            headers: {
              "content-type": "application/json",
            },
          });

          const data = await response.json();

          console.log(data);

          const involvedSockets = [
            clients.get(data.data.conversation_user_id.toString()),
            clients.get(data.data.conversation_admin_id.toString()),
          ];

          involvedSockets.forEach((socket) => {
            console.log(socket, "socket");
            socket &&
              socket &&
              socket.readyState === socket.OPEN &&
              socket?.send(JSON.stringify(payload));
          });
        }
        break;
      case "focus":
      case "active-typing":
      case "idle-typing":
      case "blur":
        {
          const payload = {
            type: json.type,
            conversation_id: json.conversation_id,
            sender_id: json.sender_id,
            deviceId: webSocket.deviceId,
          };

          const members = await getConversationMembers(json.conversation_id);

          if (!members) return;

          const involvedSockets = [
            clients.get(members.conversation_user_id),
            clients.get(members.conversation_admin_id),
          ];

          involvedSockets.forEach((socket) => {
            socket &&
              socket &&
              socket.readyState === socket.OPEN &&
              socket?.send(JSON.stringify(payload));
          });
        }
        break;
      case "edit_message":
        {
          const payload = {
            type: "edit_message",
            message: json.message,
            message_id: json.message_id,
            conversation_id: json.conversation_id,
            sender_id: json.sender_id,
            deviceId: webSocket.deviceId,
          };

          const response = await fetch(`${BACKEND_URL}/messages/update`, {
            method: "POST",
            body: JSON.stringify({
              message: payload.message,
              message_id: payload.message,
            }),
            headers: {
              "content-type": "application/json",
            },
          });

          const data = await response.json();

          const involvedSockets = [
            clients.get(data.data.conversation_user_id.toString()),
            clients.get(data.data.conversation_admin_id.toString()),
          ];

          involvedSockets.forEach((socket) => {
            socket &&
              socket.readyState === socket.OPEN &&
              socket?.send(JSON.stringify(payload));
          });
        }
        break;
      case "delete_message":
        {
          const payload = {
            type: "delete_message",
            message_id: json.message_id,
            deviceId: webSocket.deviceId,
          };

          const response = await fetch(`${BACKEND_URL}/messages/delete`, {
            method: "POST",
            body: JSON.stringify({
              message_id: payload.message,
            }),
            headers: {
              "content-type": "application/json",
            },
          });

          const data = await response.json();

          const involvedSockets = [
            clients.get(data.data.conversation_user_id.toString()),
            clients.get(data.data.conversation_admin_id.toString()),
          ];

          involvedSockets.forEach((socket) => {
            socket &&
              socket.readyState === socket.OPEN &&
              socket?.send(JSON.stringify(payload));
          });
        }
        break;
      default:
        break;
    }
  });
});

async function getConversationMembers(conversation_id) {
  if (conversationsMap.has(conversation_id)) {
    return conversationsMap.get(conversation_id);
  } else {
    const response = await fetch(
      `${BACKEND_URL}/messages/conversation/${conversation_id}`,
      {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
      }
    );

    const data = await response.json();

    const payload = {
      conversation_user_id: data.data.conversation_user_id.toString(),
      conversation_admin_id: data.data.conversation_admin_id.toString(),
    };

    conversationsMap.set(conversation_id, payload);

    return payload;
  }
}

console.log("Webmaster socket server is running");

// import url from "url";
// import { WebSocketServer } from "ws";

// const webSocketSecure = new WebSocketServer({
//   port: 8080,
// });

// const conversations = [
//   {
//     id: "123",
//     members: ["123", "456"],
//     messages: [
//       {
//         id: "",
//         text: "",
//         message: "",
//         sender_id: "",
//         read: false,
//       },
//     ],
//   },
//   {
//     id: "456",
//     members: ["123", "456"],
//     messages: [
//       {
//         id: "",
//         text: "",
//         message: "",
//         sender_id: "",
//         read: false,
//       },
//     ],
//   },
//   {
//     id: "536345",
//     members: ["123", "456"],
//     messages: [
//       {
//         id: "",
//         text: "",
//         message: "",
//         sender_id: "",
//         read: false,
//       },
//     ],
//   },
// ];

// const clients = new Map();

// webSocketSecure.on("connection", (webSocket, request) => {
//   const userId = url.parse(request.url, true).query.userId;
//   console.log(`someone connected! ${userId}`);
//   clients.set(userId, webSocket);

//   webSocket.on("message", (data) => {
//     const json = JSON.parse(Buffer.from(data).toString());

//     const conversation = conversations.find(
//       (conversation) => conversation.id === json.conversation_id
//     );

//     if (!conversation) return;

//     switch (json.type) {
//       case "send_message":
//         conversation?.members?.forEach((member) => {
//           const ws = clients.get(member);
//           ws?.send(
//             JSON.stringify({
//               ...json,
//               type: "message_sent",
//               message: json.message,
//               read: false,
//               message_id: json.message_id,
//               conversation_id: json.conversation_id,
//               sender_id: json.sender_id,
//               time: json.time,
//               ...(json.reply && { reply: json.reply }),
//             })
//           );
//         });
//         break;
//       case "delivered_message":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);
//           setTimeout(() => {
//             ws?.send(
//               JSON.stringify({
//                 ...json,
//                 type: "message_delivered",
//                 message: json.message,
//                 read: false,
//                 message_id: json.message_id,
//                 conversation_id: json.conversation_id,
//                 sender_id: json.sender_id,
//                 time: json.time,
//                 ...(json.reply && { reply: json.reply }),
//               })
//             );
//           }, 500);
//         });
//         break;
//       case "read_message":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);
//           setTimeout(() => {
//             ws?.send(
//               JSON.stringify({
//                 type: "message_read",
//                 message: json.message,
//                 read: false,
//                 message_id: json.message_id,
//                 conversation_id: json.conversation_id,
//                 sender_id: json.sender_id,
//                 time: json.time,
//                 ...(json.reply && { reply: json.reply }),
//               })
//             );
//           }, 500);
//         });
//         break;
//       case "read_conversation":
//         conversation?.members?.forEach((member) => {
//           const ws = clients.get(member);
//           if (ws && ws.readyState === WebSocket.OPEN) {
//             ws.send(
//               JSON.stringify({
//                 type: "conversatoin_read",
//                 conversation_id: json.conversation_id,
//                 sender_id: json.sender_id,
//               })
//             );
//           }
//         });
//         break;
//       case "focus":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);

//           ws?.send(
//             JSON.stringify({
//               type: "focus",
//               conversation_id: json.conversation_id,
//               sender_id: json.sender_id,
//             })
//           );
//         });
//         break;
//       case "active-typing":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);
//           ws?.send(
//             JSON.stringify({
//               type: "active-typing",
//               conversation_id: json.conversation_id,
//               sender_id: json.sender_id,
//             })
//           );
//         });
//         break;
//       case "idle-typing":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);
//           ws?.send(
//             JSON.stringify({
//               type: "idle-typing",
//               conversation_id: json.conversation_id,
//               sender_id: json.sender_id,
//             })
//           );
//         });
//         break;
//       case "blur":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);
//           ws?.send(
//             JSON.stringify({
//               type: "blur",
//               conversation_id: json.conversation_id,
//               sender_id: json.sender_id,
//             })
//           );
//         });
//         break;
//       case "edit_message":
//         conversation.members.forEach((member) => {
//           const ws = clients.get(member);
//           setTimeout(() => {
//             ws?.send(
//               JSON.stringify({
//                 type: "edit_message",
//                 message: json.message,
//                 read: false,
//                 message_id: json.message_id,
//                 conversation_id: json.conversation_id,
//                 sender_id: json.sender_id,
//               })
//             );
//           }, 1000);
//         });
//         break;
//       case "delete_message":
//         conversation?.members?.forEach((member) => {
//           const ws = clients.get(member);
//           setTimeout(() => {
//             ws?.send(
//               JSON.stringify({
//                 type: "delete_message",
//                 message: json.message,
//                 read: false,
//                 message_id: json.message_id,
//                 conversation_id: json.conversation_id,
//                 sender_id: json.sender_id,
//               })
//             );
//           }, 1000);
//         });
//         break;
//       default:
//         break;
//     }
//   });
// });
