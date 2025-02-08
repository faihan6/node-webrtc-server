const { CustomEventTarget } = require("../helpers/common_helper");
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

    #sendToClient = null;

    constructor({mid, direction, mediaType, extensions, payloadTypes, sendToClient}){
        super();
        this.mid = mid;
        this.direction = direction;
        this.mediaType = mediaType;
        this.extensions = extensions;
        this.payloadTypes = payloadTypes;
        this.#sendToClient = sendToClient;

        /**
         * @type {RTPStream | null}
         */
        this.senderStream = null;

        /**
         * @type {RTPStream | null}
         */
        this.receiverStream = null;

        console.log('Transceiver created with mid', mid, 'direction', direction, 'mediaType', mediaType);
        if(direction == 'sendrecv' || direction == 'recvonly'){
            this.receiverStream = new RTPStream(this.#sendToClient);
        }

    }

    setSenderStream(stream){
        if(this.direction == 'sendrecv' || this.direction == 'sendonly'){
            this.senderStream = stream;

            this.senderStream.addEventListener('data', (packet, packetInfo) => {

                // Note: you might get RTP packets or RTCP SR packets (from the source of RTP).

                // TODO: change the mid of the packet to the mid of this transceiver only for RTP

                const rtpPayloadType = packet[1] & 0b01111111;

                if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
                    //console.log('before fixing pt', packet);
                    packet = this.#fixPayloadType(packet, packetInfo);
                    //console.log('after fixing pt', packet);
                }

                this.dispatchEvent('rtp_for_client', packet);
                
                
            })
        }
        else{
            throw new Error('Cannot set sender stream for a recvonly transceiver');
        }
    }

    writeRTPToConsumer(packet){
        const rtpPayloadType = packet.readUInt8(1) & 0b01111111;
        const packetInfo = {
            codec: this.payloadTypes[rtpPayloadType]
        }
        this.receiverStream.controller.write(packet, packetInfo);
    }

    writeFeedbackToProducer(packet){
        this.senderStream.feedback(packet);
    }

    #fixPayloadType(rtpPacket, packetInfo){
        const payloadTypeInPacket = rtpPacket[1] & 0b01111111;
        const codec = packetInfo.codec;
        const expectedPayloadType = Object.keys(this.payloadTypes).find(key => this.payloadTypes[key] == codec);

        if(payloadTypeInPacket != expectedPayloadType){

            // clone packet
            rtpPacket = Buffer.from(rtpPacket);

            let temp = rtpPacket[1] & 0b10000000;
            temp |= expectedPayloadType;
            rtpPacket[1] = temp;
        }

        return rtpPacket;
    }

    
}

module.exports = {
    Transceiver
}