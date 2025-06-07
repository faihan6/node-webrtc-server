const { CustomEventTarget } = require("../helpers/common_helper");

class RTPStreamController extends CustomEventTarget{

    constructor(){
        super();
    }

    write(...data){
        this.dispatchEvent('data', ...data);
    }
}

class RTPStream extends CustomEventTarget{

    #onFeedback = null;
    #controller = null;

    constructor({controller, onFeedback}){
        super();
        this.#onFeedback = onFeedback;
        this.#controller = controller;

        this.#controller.addEventListener(
            'data', 
            (...data) => this.dispatchEventWithClonedArgs('data', ...data)
        );

    }

    feedback(...data){
        this.#onFeedback?.(...data);
    }

}

module.exports = {
    RTPStream,
    RTPStreamController
}


