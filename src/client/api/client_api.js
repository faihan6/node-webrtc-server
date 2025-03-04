class ServerContext extends EventTarget{

    #ws = null;
    userId = Math.random().toString(36).substring(2, 7);

    #usersSet = new Set();

    constructor(){
        super()
    }

    // TODO: implement retries
    async connect(url){

        console.log('Self User ID', this.userId);

        if(!url){
            url = `ws://${window.location.hostname}:8080`;
        }

        this.#ws = new WebSocket(url);
        const ws = this.#ws;
        ws.onmessage = this.#handleMessage.bind(this);

        
        return new Promise(res => {
            const onopen = async () => {
                console.log('Connected to server');
    
                const params = {userId: this.userId};
                const response = await this.#call('login', params, true);

                response.usersList.forEach(userId => {
                    if(userId == this.userId){
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

            const onmessage = (e) => {
                const data = JSON.parse(e.data);
                if(data.id === id){
                    this.#ws.removeEventListener('message', onmessage);
                    resolve(data.params);
                }
            }
            

            this.#ws.addEventListener('message', onmessage)
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

    #handleMessage(message){
        const data = JSON.parse(message.data);
        console.log('Received message', data);

        if(data.method == 'broadcast'){
            const params = data.params;
            if(params.type == 'user-joined'){
                this.#usersSet.add(params.userId);
                this.dispatchEvent(new CustomEvent('user-joined', {detail: params}));
            }
            else if(params.type == 'user-left'){
                this.#usersSet.delete(params.userId);
                this.dispatchEvent(new CustomEvent('user-left', {detail: params}));
            }
        }
    }



}

export { ServerContext }