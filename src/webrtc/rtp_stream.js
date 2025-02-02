const { CustomEventTarget } = require("../helpers/common_helper");

class RTPStream extends CustomEventTarget{

    controller = {
        write: (...data) => this.#write(...data)
    }

    #onFeedback = null;

    constructor(onFeedback){
        super();
        this.#onFeedback = onFeedback;

    }

    #write(...data){
        this.dispatchEvent('data', ...data);
    }

    feedback(...data){
        this.#onFeedback(...data);
    }

}

module.exports = {
    RTPStream
}


