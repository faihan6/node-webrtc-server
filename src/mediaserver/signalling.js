
const fs = require('fs');

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

const PORT = 8080;


function initializeSignalling(){

    
    let server;
    if(globalThis.serverConfig.disableSecureWebSocket){
        console.log(`Using HTTP server on port ${PORT}`);
        server = new WebSocket.Server({ port: PORT });
    }
    else{
        const https = require('https');

        console.log(`Using HTTPS server on port ${PORT}`);

        // Read SSL certificate and key files
        const serverOptions = {
            cert: fs.readFileSync(globalThis.serverConfig.websocketServerCertificatePath),
            key: fs.readFileSync(globalThis.serverConfig.websocketServerKeyPath)
        };

        // Create HTTPS server
        const httpsServer = https.createServer(serverOptions);
        httpsServer.listen(PORT, () => {
            console.log(`HTTPS server running on port ${PORT}`);
        });
        
        // Create WebSocket server attached to HTTPS server
        server = new WebSocket.Server({ server: httpsServer});

        
    }

    console.log("Server type:", server.constructor.name);
    
    // Start WS server on port 8080
    server.on('listening', () => {
        console.log(`WebSocket server running on port ${PORT}`);
    });

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

                const senderUser = users.find(user => user.userId == producerId);
                const receiverUser = wsUserMap.get(ws);

                if(receiverUser.peer.signallingState != 'stable'){
                    console.log('waiting for signalling to be done for receiver peer', receiverUser.userId);
                    await new Promise(res => receiverUser.peer.addEventListener('signalling_stable', res));
                }
                console.log('signalling is done for receiver peer', receiverUser.userId);

                const audioStream = senderUser.peer.getTransceivers()[0].receiver.stream;
                receiverUser.peer.getTransceivers()[audioMid].sender.replaceStream(audioStream);

                const videoStream = senderUser.peer.getTransceivers()[1].receiver.stream;
                receiverUser.peer.getTransceivers()[videoMid].sender.replaceStream(videoStream);

                // TODO: request key frame from senderUser's receiver
                senderUser.peer.getTransceivers()[1].receiver.requestKeyFrame();


                console.log(`client subscribed: user ${receiverUser.userId} | direction: ${receiverUser.peer.selfDirection}`);
                
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