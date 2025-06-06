const WebSocket = require('ws');
const { UserContext } = require('./user_context');

/** @type {UserContext[]} */
const users = []

/**
 * @type {Map<WebSocket, UserContext>}
 */
const wsUserMap = new WeakMap();

/**
 * TODO: Read below
 * 1. Stop sending packets when peer is not connected. (Firefox not connected, no SRTPCtx, still we try to encrypt/send packets).
 * 2. Clear ws/UserContext from objects once ws closes.
 * 3. Do not send leave messages for someone for whom joined message wasn't sent
 */


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

                const peerStableUsers = users.filter(user => user.peer?.signallingState == 'stable').map(user => user.getDetails())

                reply({
                    status: 'success',
                    usersList : peerStableUsers
                });

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

                if(answerSDP){
                    const broadCastMessage = {
                        type: 'user-joined',
                        userDetails: user.getDetails()
                    }
                    broadcast(broadCastMessage, user);
                }
            }
        })

        ws.on('close', () => {
            const user = wsUserMap.get(ws);
            console.log(`client disconnected: user ${user.userId}`);
            wsUserMap.delete(ws);
            users.splice(users.indexOf(user), 1);

            const broadCastMessage = {
                type: 'user-left',
                userId: user.userId
            }
            broadcast(broadCastMessage, user);
        });

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