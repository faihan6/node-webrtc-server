const { CustomEventTarget } = require("../helpers/common_helper");
const { RTPSender, RTPReceiver, RTPHelpers } = require("./rtp");
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

    /** @type {RTPSender} */
    senderCtx = null;

    /** @type {RTPReceiver} */
    receiverCtx = null;

    #controller = null;

    #handleRTPFromSenderStream = null;

    constructor({mid, direction, mediaType, extensions, payloadTypes, iceContext, dtlsContext, srtpContext, controller}){
        super();
        this.mid = mid;
        this.direction = direction;
        this.mediaType = mediaType;
        this.extensions = extensions;
        this.payloadTypes = payloadTypes;

        this.#iceContext = iceContext;
        this.#dtlsContext = dtlsContext;
        this.srtpContext = srtpContext;

        this.#dtlsContext.addEventListener('dtlsParamsReady', params => {
            this.srtpContext.initSRTP(params);
        });

        if(direction == 'sendrecv' || direction == 'sendonly'){
            this.outgoingSSRC = 100 + Number(mid);
            this.senderCtx = new RTPSender({
                outgoingSSRC: this.outgoingSSRC,
                // TODO: get clockRate from SDP
                clockRate: mediaType == 'audio' ? 48000 : 90000,
            });
            this.#handleRTPFromSenderStream = (packet, packetInfo) => this.#handleRTPToClient(packet, packetInfo)
        }
        if(direction == 'sendrecv' || direction == 'recvonly'){
            this.receiverCtx = new RTPReceiver();
            this.#receiverStream = new RTPStream((...data) => this.#handleRTCPToClient(...data));
        }

        this.#controller = controller;
        this.#controller.addEventListener('packet', packet => this.#handlePacketFromClient(packet));

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
            const extensionsInfo = RTPHelpers.parseHeaderExtensions(packet);
            packet = this.srtpContext.encryptPacket(packet, extensionsInfo);
        }
        if(packet){
            this.#iceContext.sendPacket(packet);
        }
        
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

    #handlePacketFromClient(packet){
        const rtpPayloadType = packet[1] & 0b01111111;
        const rtcpPacketType = packet[1];
        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            // RTP-i
            this.#handleRTPFromClient(packet);
        }
        else if(rtcpPacketType == 200){
            // FB-i
            this.#handleSenderReportFromClient(packet);
        }
        else if(rtcpPacketType >= 201 && rtcpPacketType <= 206){
            // FB-o
            this.#handleFeedbackForProducerFromClient(packet);
        }
    }

    #handleRTPFromClient(packet){

        const rtpPayloadType = packet[1] & 0b01111111;

        if((rtpPayloadType >= 96 && rtpPayloadType <= 127)){
            // RTP-i
            if(this.srtpContext){
                const extensionsInfo = RTPHelpers.parseHeaderExtensions(packet);
                packet = this.srtpContext.decryptPacket(packet, extensionsInfo);
                if(!packet){
                    return;
                }
            }
            this.receiverCtx.processRTPFromClient(packet);
        }

        const packetInfo = {
            codec: this.payloadTypes[rtpPayloadType]
        }
        this.#receiverStream.controller.write(packet, packetInfo);
    }

    #handleSenderReportFromClient(packet){
        if(this.srtpContext){
            packet = this.srtpContext.decryptPacket(packet);
            if(!packet){
                return
            }
        }
        this.receiverCtx.processSRFromClient(packet);
    }

    #handleFeedbackForProducerFromClient(packet){
        if(this.srtpContext){
            packet = this.srtpContext.decryptPacket(packet);
            if(!packet){
                return
            }
        }
        
        if(packet[1] == 201){
            // Receiver Report! Do not forward to stream
            // TODO: Collect stats before retuning
            return;
        }

        console.log("got", this.#getRTCPPacketTypeStr(packet));

        this.#senderStream.feedback(packet);
    }

    #getRTCPPacketTypeStr(packet){
        // check if packet is NACK/PLI/FIR/TWCC/RR and print log
        const fmt = packet[0] & 0b11111; // Feedback message type (for PT=205/206)
        const packetType = packet[1]; // RTCP Packet Type

        switch (packetType) {
            case 201:
                //return ("got Receiver Report (RR), not forwarding it to sender!");
                return;
            case 205:
                if (fmt === 1) {
                    return ("NACK (Negative Acknowledgment)");
                } else if (fmt === 15) {
                    return ("TWCC (Transport-Wide Congestion Control)");
                } else {
                    return ("Unknown RTPFB packet");
                }
                break;
            case 206:
                if (fmt === 1) {
                    return ("PLI (Picture Loss Indication)");
                } else if (fmt === 4) {
                    return ("FIR (Full Intra Request)");
                } else {
                    return ("Unknown Payload specific FB packet");
                }
                break;
            default:
                return ("Unknown RTCP packet type:", packetType);

        }
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
            packet = this.senderCtx.processRTPToClient(packet);
        }
        else{
            // Must be RTCP Sender Report. We will generate our own SR. ignore..
            //packet = this.receiver.processFeedbackToClient(packet);
        }

        this.#sendPacketToClient(packet);
        
        
        
    }

    #handleRTCPToClient(packet){

        //TODO: ideally, you need to debounce/throttle the RTCP packets to be sent to the client

        console.log('sending', this.#getRTCPPacketTypeStr(packet), 'to client');
       
        const ssrc = packet.readUInt32BE(8)
        packet = this.receiverCtx.processFeedbackToClient(packet);
        const ssrcAfter = packet.readUInt32BE(8);
        console.log('SSRC in RTCP packet', ssrc, 'SSRC after processing', ssrcAfter);
        this.#sendPacketToClient(packet);
    }

    requestKeyFrame(){
        let packet = RTPHelpers.generatePLI(0);
        console.log('requesting PLI from receiver stream', packet);
        this.#receiverStream.feedback(packet);

    }
    
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