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

        this.#dtlsContext?.addEventListener('dtlsParamsReady', params => {
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

            /**
             * feedbacks for the client can come from two places.
             *      One is from the consumer (PLI/FIR) - comes from the RTPStream's feedback() method
             *      Other is from the RTPReceiver (NACK/Receiver report) - comes from the RTPReceiver's send_fb_i_to_client event
             */
            this.#receiverStream = new RTPStream((...data) => this.#handleRTCPToClient(...data));
            this.receiverCtx.addEventListener('send_fb_i_to_client', (...data) => this.#handleRTCPToClient(...data));
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
        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            // RTP-i
            this.#handleRTPFromClient(packet);
        }
        else{
            // RTCP packet. (Definitely not a compound one)
            const rtcpPacketType = packet[1];
            if(rtcpPacketType == 200){
                // FB-i
                console.log('\t======== got sender report packet =============', rtcpPacketType);
                this.#handleSenderReportFromClient(packet);
            }
            else if(rtcpPacketType >= 201 && rtcpPacketType <= 206){
                // FB-o
                console.log('\t======== got feedback packet =============', rtcpPacketType, RTPHelpers.getRTCPPacketTypeStr(packet));
                this.#handleFeedbackForProducerFromClient(packet);
            }
        }
    }

    #handleRTPFromClient(packet){

        const rtpPayloadType = packet[1] & 0b01111111;

        if((rtpPayloadType >= 96 && rtpPayloadType <= 127)){
            // RTP-i
            // if(this.srtpContext){
            //     const extensionsInfo = RTPHelpers.parseHeaderExtensions(packet);
            //     packet = this.srtpContext.decryptPacket(packet, extensionsInfo);
            //     if(!packet){
            //         return;
            //     }
            // }
            this.receiverCtx.processRTPFromClient(packet);
        }

        const packetInfo = {
            codec: this.payloadTypes[rtpPayloadType]
        }
        this.#receiverStream.controller.write(packet, packetInfo);
    }

    #handleSenderReportFromClient(packet){
        this.receiverCtx.processSRFromClient(packet);
    }

    #handleFeedbackForProducerFromClient(packet){

        const packetDetails = RTPHelpers.identifyRTPPacket(packet);

        if(packetDetails.rtcpSubType != 'PLI' && packetDetails.rtcpSubType != 'FIR'){
            console.log(`Not forwarding ${packetDetails.rtcpSubType} to producer stream`);
            return 
        }

        console.log(`Forwarding ${packetDetails.rtcpSubType} to producer stream`);
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
        
        const packetData = RTPHelpers.identifyRTPPacket(packet);
        //console.log('RTCP packet received from consumer', packetData, packet.slice(0, 18));
        if(packetData.rtcpPacketType == 206){
            if(packetData.rtcpSubType == 'PLI'){
                console.log('PLI received from consumer');

                const ssrc = packet.readUInt32BE(8)
                packet = this.receiverCtx.processFeedbackToClient(packet);
                const ssrcAfter = packet.readUInt32BE(8);
                console.log('SSRC in RTCP packet', ssrc, 'SSRC after processing', ssrcAfter);
                
                this.#sendPacketToClient(packet);
                return;
            }
            else if(packetData.rtcpSubType == 'FIR'){
                console.log('FIR received from consumer');
                this.requestKeyFrame();
                return;
            }

        }

        
       
        const ssrc = packet.readUInt32BE(8)
        packet = this.receiverCtx.processFeedbackToClient(packet);
        const ssrcAfter = packet.readUInt32BE(8);
        console.log('SSRC in RTCP packet', ssrc, 'SSRC after processing', ssrcAfter);
        this.#sendPacketToClient(packet);
    }

    requestKeyFrame(){
        let packet = RTPHelpers.generatePLI(0);
        console.trace('requesting PLI from receiver stream', packet);
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