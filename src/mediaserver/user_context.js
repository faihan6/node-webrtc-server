const { PeerContext } = require('../webrtc/peer_context');

class UserContext{

    ws = null;

    constructor({userId, ws}){

        this.userId = userId;
        this.ws = ws;
        this.peer = new PeerContext({id: this.userId});

        console.log(`New client connected : user ${this.userId}`);
    
        this.ws.on('close', () => {
            console.log(`Client disconnected : user ${this.userId}`);
        });

    }

    


    
}

module.exports = {
    UserContext
}