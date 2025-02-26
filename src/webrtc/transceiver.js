const { CustomEventTarget } = require("../helpers/common_helper");
const { RTPContext } = require("./rtp");
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

    #iceContext = null;
    #dtlsContext = null;

    #rtpContext = null;
    srtpContext = null;

    /**
     * @type {RTPStream}
     * stream that sends packets to the client
     */
    #senderStream = null;

    /**
     * @type {RTPStream}
     * stream that receives packets from the client
     */
    #receiverStream = null;

    #handleRTPFromSenderStream = (packet, packetInfo) => this.#handleRTPToClient(packet, packetInfo)

    constructor({mid, direction, mediaType, extensions, payloadTypes, iceContext, dtlsContext, srtpContext}){
        super();
        this.mid = mid;
        this.direction = direction;
        this.mediaType = mediaType;
        this.extensions = extensions;
        this.payloadTypes = payloadTypes;

        this.#iceContext = iceContext;
        this.#dtlsContext = dtlsContext;
        this.srtpContext = srtpContext;

        this.outgoingSSRC = 100 + Number(mid);
        this.#rtpContext = new RTPContext(this.outgoingSSRC);

        this.#receiverStream = (direction == 'sendrecv' || direction == 'recvonly') ? 
            new RTPStream((...data) => this.#handleRTCPToClient(...data)) : 
            null;

        this.#dtlsContext.addEventListener('dtlsParamsReady', params => {
            this.srtpContext.initSRTP(params);
        });

        this.#rtpContext.addEventListener('send_fb_i_to_client', packet => this.#sendPacketToClient(packet));

        console.log('Transceiver created with mid', mid, 'direction', direction, 'mediaType', mediaType);
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

    #sendPacketToClient(packet){
        // encrypt the packet if required
        if(this.srtpContext){
            const extensionsInfo = RTPContext.parseHeaderExtensions(packet);
            packet = this.srtpContext.encryptPacket(packet, extensionsInfo);
        }
        this.#iceContext.sendPacket(packet);
    }

    setSenderStream(stream){
        if(this.direction == 'sendrecv' || this.direction == 'sendonly'){

            // remove previous listener, if any
            this.#senderStream?.removeEventListener('data', this.#handleRTPFromSenderStream);

            this.#senderStream = stream;
            this.#senderStream.addEventListener('data', this.#handleRTPFromSenderStream);
        }
        else{
            throw new Error('Cannot set sender stream for a recvonly transceiver');
        }
    }

    getReceiverStream(){
        return this.#receiverStream;
    }

    handleRTPFromClient(packet){

        const rtpPayloadType = packet[1] & 0b01111111;

        if((rtpPayloadType >= 96 && rtpPayloadType <= 127)){
            // RTP-i
            if(this.srtpContext){
                const extensionsInfo = RTPContext.parseHeaderExtensions(packet);
                packet = this.srtpContext.decryptPacket(packet, extensionsInfo);
            }
            this.#rtpContext.processRTPFromClient(packet);
        }

        const packetInfo = {
            codec: this.payloadTypes[rtpPayloadType]
        }
        this.#receiverStream.controller.write(packet, packetInfo);
    }

    handleSenderReportFromClient(packet){
        if(this.srtpContext){
            packet = this.srtpContext.decryptPacket(packet);
        }
        this.#rtpContext.processFeedbackFromClient(packet);
        this.#receiverStream.controller.write(packet);
    }

    handleFeedbackForProducerFromClient(packet){
        if(this.srtpContext){
            packet = this.srtpContext.decryptPacket(packet);
        }
        
        // check if packet is NACK/PLI/FIR/TWCC/RR and print log
        const fmt = packet[0] & 0b11111; // Feedback message type (for PT=205/206)
        const packetType = packet[1]; // RTCP Packet Type

        switch (packetType) {
            case 201:
                console.log("got Receiver Report (RR)");
                break;
            case 205:
                if (fmt === 1) {
                    console.log("got NACK (Negative Acknowledgment)");
                } else if (fmt === 15) {
                    console.log("got TWCC (Transport-Wide Congestion Control)");
                } else {
                    console.log("git Unknown RTPFB packet");
                }
                break;
            case 206:
                if (fmt === 1) {
                    console.log("got PLI (Picture Loss Indication)");
                } else if (fmt === 4) {
                    console.log("got FIR (Full Intra Request)");
                } else {
                    console.log("got Unknown Payload specific FB packet");
                }
                break;
            default:
                console.log("got Unknown RTCP packet type:", packetType);

        }

        this.#senderStream.feedback(packet);
    }


    #handleRTPToClient(packet, packetInfo){

        const rtpPayloadType = packet[1] & 0b01111111;
        const rtcpPacketType = packet[1];

        //console.log('Received packet from producer', rtpPayloadType, rtcpPacketType, packet.slice(0, 18));

        // process RTP
        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            /*
                Receiving client is not able to demux RTP packets when sender joins first and receiver joins next. 
                Happens since RTP packets in the middle of stream have neither extension headers, nor ssrcs specified in SDP.

                TODO: Do one of the following
                    1. If this is one of first few packets in this outgoing ssrc, add mid extenion (if supported)
                    2. Change SSRC to the one mapped for this TX (RTPContext)
            */
            packet = this.#fixPayloadType(packet, packetInfo);
            packet = this.#rtpContext.processRTPToClient(packet);
        }
        else{
            // Must be RTCP Sender Report. We will generate our own SR. ignore..
            //packet = this.#rtpContext.processFeedbackToClient(packet);
        }

        this.#sendPacketToClient(packet);
        
        
        
    }

    #handleRTCPToClient(packet){

        //TODO: ideally, you need to debounce/throttle the RTCP packets to be sent to the client

        const fmt = packet[0] & 0b11111; // Feedback message type (for PT=205/206)
        const packetType = packet[1]; // RTCP Packet Type

        switch (packetType) {
            case 201:
                console.log("sending Receiver Report (RR)");
                break;
            case 205:
                if (fmt === 1) {
                    console.log("sending NACK (Negative Acknowledgment)");
                } else if (fmt === 15) {
                    console.log("sending TWCC (Transport-Wide Congestion Control)");
                } else {
                    console.log("sending Unknown RTPFB packet");
                }
                break;
            case 206:
                if (fmt === 1) {
                    console.log("sending PLI (Picture Loss Indication)");
                } else if (fmt === 4) {
                    console.log("sending FIR (Full Intra Request)");
                } else {
                    console.log("Unknown Payload specific FB packet");
                }
                break;
            default:
                console.log("Unknown RTCP packet type:", packetType);

        }
        const ssrc = packet.readUInt32BE(8)
        packet = this.#rtpContext.processFeedbackToClient(packet);
        const ssrcAfter = packet.readUInt32BE(8);
        console.log('SSRC in RTCP packet', ssrc, 'SSRC after processing', ssrcAfter);
        this.#sendPacketToClient(packet);
    }

    requestKeyFrame(){
        let packet = RTPContext.generatePLI(0);
        packet = this.#rtpContext.processFeedbackToClient(packet);
        console.log('Sending PLI to client', packet);
        this.#sendPacketToClient(packet);

    }
    
}

module.exports = {
    Transceiver
}