const { PeerContext } = require('../webrtc/peer_context');

class UserContext{

    ws = null;

    constructor(data){

        this.userId = Math.random().toString(36).substring(7);
        this.ws = data.ws;
        this.peer = new PeerContext({id: this.userId});

        console.log(`New client connected : user ${this.userId}`);

        this.ws.on('message', async (message) => {
            //console.log(`Received message for ${this.userId}: ${message}`);

            const data = JSON.parse(message);

            if(data.type == 'offer'){
                const answer = await this.peer.generateAnswer(data);
                this.ws.send(JSON.stringify({type: 'answer', sdp: answer}));
            }

        });
    
        this.ws.on('close', () => {
            console.log(`Client disconnected : user ${this.userId}`);
        });

    }

    


    
}

module.exports = {
    UserContext
}