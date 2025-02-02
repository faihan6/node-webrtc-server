const WebSocket = require('ws');
const { UserContext } = require('./user_context');

function initializeSignalling(){
    const server = new WebSocket.Server({ port: 8080 });
    const users = []

    const receivers = [];
    let sender = null;

    server.on('connection', (ws) => {
        const user = new UserContext({ws});
        users.push(user);

        console.log(`New client connected : user ${user.userId} | direction: ${user.peer.selfDirection}`);
        
        ws.addEventListener('message', async (event) => {
            const message = JSON.parse(event.data);
            
            if(message.method == 'login'){
                if(message.params.userId.includes('my-receiver')){
                    const receiver = user
                    receivers.push(receiver);

                    
                    // If there is a sender, 
                    // make the receiver subscribe to the sender's RTP stream
                    //make the sender subscribe to the receiver's RTCP events
                    if(sender){

                        const rtpStream = sender.peer.subscribeToRTPStream(null);
                        receiver.peer.addRTPStream(rtpStream);

                        // TODO: ideally we need to subscribe only for Events (PLI and FIR) not for all RTP packets.
                        const eventStream = receiver.peer.subscribeToRTCPEventsStream(null);
                        sender.peer.addRTCPEventsStream(eventStream);
                    }
                }
                else if(message.params.userId == 'my-sender-1'){
                    sender = user;

                    console.log('Sender is ready');
                    console.log('receivers are..', receivers);

                    await new Promise(res => sender.peer.addEventListener('signalling_stable', res));
            
                    
                    for(const receiver of receivers){
                        
                        const mids = [0, 1];
                        
                        for(const mid of mids){
                            console.log(receiver.userId, 'Subscribing to mid', mid);
                            const stream = sender.peer.transceivers[mid].receiverStream
                            receiver.peer.transceivers[mid].setSenderStream(stream);
                        }
                        
                    }
                }
            }
        })

    });

    console.log('WebSocket server is running on ws://localhost:8080');
}

module.exports = {
    initializeSignalling
}