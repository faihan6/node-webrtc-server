const WebSocket = require('ws');
const { UserContext } = require('./user_context');

const users = []
const wsUserMap = new Map();


function initializeSignalling(){
    const server = new WebSocket.Server({ port: 8080 });

    server.on('connection', (ws) => {

        console.log(`client connected`);
        
        ws.addEventListener('message', async (event) => {
            const message = JSON.parse(event.data);
            console.log('Received message', message);
            if(message.method == 'login'){
                const userId = message.params.userId;
                const user = new UserContext({ws, userId});
                users.push(user);
                wsUserMap.set(ws, user);

                console.log(`client loggedIn: user ${user.userId} | direction: ${user.peer.selfDirection}`);
            }

            if(message.method == 'subscribe'){
                const producerId = message.params.producerId;
                const audioMid = message.params.audioMid;
                const videoMid = message.params.videoMid;

                const sender = users.find(user => user.userId == producerId);
                const receiver = wsUserMap.get(ws);

                if(receiver.peer.signallingState != 'stable'){
                    console.log('waiting for signalling to be done for receiver peer', receiver.userId);
                    await new Promise(res => receiver.peer.addEventListener('signalling_stable', res));
                }
                console.log('signalling is done for receiver peer', receiver.userId);

                const audioStream = sender.peer.transceivers[0].getReceiverStream();
                receiver.peer.transceivers[audioMid].setSenderStream(audioStream);

                const videoStream = sender.peer.transceivers[1].getReceiverStream();
                receiver.peer.transceivers[videoMid].setSenderStream(videoStream);

                console.log(`client subscribed: user ${receiver.userId} | direction: ${receiver.peer.selfDirection}`);
                
            }
        })

    });

    console.log('WebSocket server is running on ws://localhost:8080');
}

module.exports = {
    initializeSignalling
}