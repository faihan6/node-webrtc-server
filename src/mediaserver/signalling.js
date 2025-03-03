const WebSocket = require('ws');
const { UserContext } = require('./user_context');

const users = []

/**
 * @type {Map<WebSocket, UserContext>}
 */
const wsUserMap = new Map();


function initializeSignalling(){
    const server = new WebSocket.Server({ port: 8080 });

    server.on('connection', (ws) => {

        console.log(`new client connected`);
        
        ws.addEventListener('message', async (event) => {

            const reply = (params) => {
                const response = {
                    id: message.id,
                    method: message.method,
                    params
                }
                ws.send(JSON.stringify(response));
            }

            const message = JSON.parse(event.data);
            console.log('Received message', message);
            
            if(message.method == 'login'){
                const userId = message.params.userId;
                const user = new UserContext({ws, userId});
                users.push(user);
                wsUserMap.set(ws, user);

                console.log(`client loggedIn: user ${user.userId} | direction: ${user.peer.selfDirection}`);

                reply({
                    status: 'success',
                    usersList : users.map(user => user.userId)
                });

                const broadCastMessage = {
                    type: 'user-joined',
                    userId: user.userId
                }
                broadcast(broadCastMessage, user);


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

                sender.peer.transceivers[1].requestKeyFrame();


                console.log(`client subscribed: user ${receiver.userId} | direction: ${receiver.peer.selfDirection}`);
                
            }

            if(message.method == 'sdp-exchange'){
                const user = wsUserMap.get(ws);
                const offer = message.params;
                user.peer.setRemoteDescription(offer);
                const answerSDP = await user.peer.generateAnswer();

                const response = {
                    type: 'answer',
                    sdp: answerSDP
                }
                
                reply(response);
            }
        })

    });

    console.log('WebSocket server is running on ws://localhost:8080');
}

function broadcast(message, self){
    for(const user of users){

        if(user.userId == self.userId){
            continue;
        }

        const msg = {
            id: Math.random().toString(36).substring(2, 7),
            method: 'broadcast',
            params: message
        }
        user.ws.send(JSON.stringify(msg));
    }
}

module.exports = {
    initializeSignalling
}