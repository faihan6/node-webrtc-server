class ServerContext{

    #ws = null;
    #userId = Math.random().toString(36).substring(2, 7);

    #usersSet = new Set();

    constructor(){}

    // TODO: implement retries
    async connect(url){

        console.log('Self User ID', this.#userId);

        if(!url){
            url = `ws://${window.location.hostname}:8080`;
        }

        this.#ws = new WebSocket(url);
        const ws = this.#ws;

        
        return new Promise(res => {
            const onopen = async () => {
                console.log('Connected to server');
    
                const params = {userId: this.#userId};
                const response = await this.#call('login', params, true);
                console.log('Login response', response);

                response.usersList.forEach(userId => {
                    if(userId == this.#userId){
                        this.#usersSet.add(userId);
                    }
                });

                res(response);
    
            }
            ws.addEventListener('open', onopen);
        })
        
        
    }

    async #call(method, params, awaitResponse, timeoutMS = 2000){
        if(!this.#ws || this.#ws.readyState !== WebSocket.OPEN){
            throw new Error('Not connected to server');
        }

        const id = Math.random().toString(36).slice(2, 8);
        const msg = {id, method, params}
        this.#ws.send(JSON.stringify(msg));

        if(!awaitResponse){
            return;
        }

        return new Promise((resolve, reject) => {

            
            setTimeout(() => {
                const err = new Error('Timeout')
                err.data = arguments;
                reject(err);
            }, timeoutMS);
            

            this.#ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if(data.id === id){
                    resolve(data.params);
                }
            }
        });
    }

    async sendOffer(offer){
        const answer = await this.#call('sdp-exchange', offer, true);
        return answer;
    }

    getUsersList(){
        return this.#usersSet;
    }

    async subscribe(producerId, audioMid, videoMid){
        const params = {producerId, audioMid, videoMid};
        await this.#call('subscribe', params, false);
    }



}

export { ServerContext }