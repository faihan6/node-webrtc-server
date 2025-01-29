const { CustomEventTarget } = require("../helpers/common_helper");

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

    constructor({mid, direction, mediaType, extensions, payloadTypes}){
        super();
        this.mid = mid;
        this.direction = direction;
        this.mediaType = mediaType;
        this.extensions = extensions;

    }

    handlePacketFromClient(packet){
        const payloadType = packet.readUInt8(1) & 0b01111111;

        if(payloadType >= 96 && payloadType <= 127){
            this.dispatchEvent('rtp_for_consumer', packet);
        }
        else if(payloadType >= 200 && payloadType <= 206){
            this.dispatchEvent('feedback_for_producer', packet);
        }
    }

    handleFeedbackForClient(packet){
        this.dispatchEvent('feedback_for_client', packet);
    }

    handleRTPForClient(packet){
        // change the mid of the packet to the mid of this transceiver

        //this.#fixPayloadType(packet, {codec: 'Video/VP8'});

        this.dispatchEvent('rtp_for_client', packet);
    }

    #fixPayloadType(rtpPacket, packetInfo){
        const payloadTypeInPacket = rtpPacket[1] & 0b01111111;
        const codec = packetInfo.codec;
        const expectedPayloadType = Object.keys(this.knownRTPPayloadTypes).find(key => this.knownRTPPayloadTypes[key] == codec);

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