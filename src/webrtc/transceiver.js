const { CustomEventTarget } = require("../helpers/common_helper");
const { RTPSender, RTPReceiver, RTPSenderController, RTPReceiverController, RTPHelpers } = require("./rtp");
const { RTPStream } = require("./rtp_stream");

/**
 * @class Transceiver
 * @extends CustomEventTarget
 * 
 * Transceivers have three types of actors related to them:
 * 1. Clients - The client is the peer that is connected to the this peer (to which the transceiver belongs)
 * 2. Consumers - These are the peers that consume the RTP stream from the client
 * 3. Producers - These are the peers that produce the RTP stream to be sent to the client
 * 
 * Note that Producers and the Client are not the same.
 * 
 * Transceiver has eight ways of communication:
 * 1. Incoming RTP stream from client (RTP-i and SR-i) intended for consumers
 * 2. Outgoing RTP stream to consumers of RTP-i (RTP-i and SR-i)
 * 
 * 3. Incoming Feedback from consumers of RTP-i (FB-i)
 * 4. Outgoing Feedback to the client (FB-i)
 * 
 * 5. Incoming RTP stream from producers that need to be sent to the client (RTP-o and SR-o)
 * 6. Outgoing RTP stream to client (RTP-o and SR-o)
 * 
 * 7. Incoming Feedback from the client (FB-o)
 * 8. Outgoing Feedback to producers (FB-o)
 *
 */

/*

 *
 *                                                                            |-----------|
 *                                                             |<-------------|  Producer |
 *                                                             |              |-----------|
 *    |--------|                             |-------------------|
 *    | Client | <------- Internet --------> | Transceiver       |
 *    |--------|                             |-------------------|             |-----------|
 *                                                             |-------------> |  Consumer |
 *                                                                             |-----------|

*/
class Transceiver extends CustomEventTarget{

    // /**
    //  * @type {RTPStream}
    //  * stream that sends packets to the client
    //  */
    // #senderStream = null;

    // /**
    //  * @type {RTPStream}
    //  * stream that receives packets from the client
    //  */
    // #receiverStream = null;

    /** @type {RTPSender} */
    sender = null;
    /** @type {RTPSenderController} */
    #senderController = null;

    /** @type {RTPReceiver} */
    receiver = null;
    /** @type {RTPReceiverController} */
    #receiverController = null;

    /** @type {TxController} */
    #controller = null;

    constructor({mid, direction, mediaType, extensions, payloadTypes, controller}){
        super();
        this.mid = mid;
        this.direction = direction;
        this.mediaType = mediaType;
        this.extensions = extensions;
        this.payloadTypes = payloadTypes;

        if(direction == 'sendrecv' || direction == 'sendonly'){
            const outgoingSSRC = 100 + Number(mid);

            // TODO: get clockRate from SDP
            const clockRate = mediaType == 'audio' ? 48000 : 90000;

            this.#senderController = new RTPSenderController();
            this.sender = new RTPSender({
                outgoingSSRC,
                clockRate,
            });
        }
        if(direction == 'sendrecv' || direction == 'recvonly'){
            this.#receiverController = new RTPReceiverController();
            console.log('receiverController', this.#receiverController);
            this.receiver = new RTPReceiver(this.#receiverController);

            /**
             * feedbacks for the client can come from two places.
             *      One is from the consumer (PLI/FIR) - comes from the RTPStream's feedback() method
             *      Other is from the RTPReceiver (NACK/Receiver report) - comes from the RTPReceiver's send_fb_i_to_client event
             */
            this.#receiverController.addEventListener('send_fb_i_to_client', (packet) => this.#controller.dispatchEvent('send_fb_i_to_client', packet));
        }

        this.#controller = controller;
        this.#controller.addEventListener('packet', packet => this.#handlePacketFromClient(packet));

        console.log('Transceiver created with mid', mid, 'direction', direction, 'mediaType', mediaType);
    }

    #handlePacketFromClient(packet){
        const rtpPayloadType = packet[1] & 0b01111111;
        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            // RTP-i
            const packetInfo = {
                codec: this.payloadTypes[rtpPayloadType]
            }
            this.#receiverController.write(packet, packetInfo);
        }
        else{
            // RTCP packet. (Definitely not a compound one)
            const rtcpPacketType = packet[1];
            if(rtcpPacketType == 200){
                // FB-i
                console.log('\t======== got sender report packet =============', rtcpPacketType);
                console.log('handle sender report from client');
                //this.#handleSenderReportFromClient(packet);
            }
            else if(rtcpPacketType >= 201 && rtcpPacketType <= 206){
                // FB-o
                console.log('\t======== got feedback packet =============', rtcpPacketType, RTPHelpers.getRTCPPacketTypeStr(packet));
                console.log('handle feedback for producer from client');
                //this.#handleFeedbackForProducerFromClient(packet);
            }
            this.#receiverController.write(packet);
        }
    }

    /* 
        TODO:

        in BUNDLE flow, packets from stream reach RTPSender directly without going through Transceiver.
        In this case, do we need fixPayloadType()?
        
        Fix:
        A RTPSender can send only one payload type.
        Can we set outgoing payloadType for RTPSender and directly use it?
    */

    
}

class TxController extends CustomEventTarget{
    constructor(){
        super()
    }

    write(packet){
        this.dispatchEvent('packet', packet);
    }
}

module.exports = {
    Transceiver, TxController
}