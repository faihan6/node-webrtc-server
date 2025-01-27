
const { ICEContext } = require('./stun');
const { DTLSContext, getFingerprintOfCertificate } = require('./dtls')
const { RTPContext } = require('./rtp');
const { SRTPContext } = require('./srtp');
const { SimpleStream } = require('../helpers/simple_stream');

class PeerContext{

    remoteCertificateFingerprint = null;

    /**
     * We support only BUNDLEing, so there is only one ice context per peer
     */
    iceContext = new ICEContext({onPacketReceived: this.allocatePacketToAppropriateMethod.bind(this)});

    // TODO: direction is a property of transceiver, not peer itself. need to change it.
    selfDirection = null;
    remoteDirection = null;

    rtpStreamSubscriberCallbacks = {};

    #remoteSSRCStreams = {
        null: {
            rtp: new SimpleStream(),
            rtcpEvents: new SimpleStream()
        }
    };
    #localSSRCStreams = {};

    dtlsContext = null;
    #srtpContext = null;

    #transceivers = {};

    constructor(){
    }

    async generateAnswer(offer) {

        /*
            TODO
                1. extract all the candidates from the offer
                2. Get ICE ufrag and pwd from the offer
                3. Get the certificate fingerprint from the offer
    
                4. Generate ICE ufrag and pwd for self
                5. Generate new certificate for self. Generate its fingerprint
    
                6. Generate answer
                    - add the self candidate
                    - add the self ufrag and pwd
                    - add the self certificate fingerprint
        */
    
        // 1. extract all the candidates from the offer
        const remoteCandidates = [];
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=candidate')) {
                remoteCandidates.push(line);
            }
        });
    
        // 2. Get ICE ufrag and pwd from the offer
        const remoteUfrag = offer.sdp.match(/a=ice-ufrag:(.*)/)[1];
        const remotePwd = offer.sdp.match(/a=ice-pwd:(.*)/)[1];
        this.iceContext.setRemoteUfragAndPassword(remoteUfrag, remotePwd);
    
        const selfUfrag = this.iceContext.selfUfrag
        const selfPwd = this.iceContext.selfPwd

        const mBlockStartIndex = offer.sdp.indexOf('m=');
        const remoteDirection = offer.sdp.slice(mBlockStartIndex).match(/a=sendrecv|a=recvonly|a=sendonly|a=inactive/)[0];
        const selfDirection = (remoteDirection == 'a=sendonly') ? 'a=recvonly' : 
                                (remoteDirection == 'a=recvonly') ? 'a=sendonly' : 
                                remoteDirection;

        const payloadTypes = {};
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=rtpmap')) {
                const payloadType = line.match(/a=rtpmap:(\d+)/)[1];
                const codec = line.split(' ')[1]
                payloadTypes[payloadType] = codec;
            }
        });

        console.log('Payload types:', payloadTypes);

        const certificateFPInOffer = offer.sdp.match(/a=fingerprint:(.*)/);
        if(certificateFPInOffer){
            if(globalThis.disableWebRTCEncryption){
                throw new Error('Fingerprint found in offer. But server is running in no encryption mode. Rejecting.');
            }
            else{
                const remoteCertificateFingerprint = certificateFPInOffer[1];
                this.dtlsContext.setRemoteFingerprint(remoteCertificateFingerprint);
            }
        }
        else{
            if(globalThis.disableWebRTCEncryption){
                console.log('No fingerprint in the offer. Remote Peer wants no encryption')
            }
            else{
                throw new Error('Fingerprint not found in offer. Rejecting');
            }
        }

        this.selfDirection = selfDirection;
        this.remoteDirection = remoteDirection;
    
        // console.log('candidates', remoteCandidates);
        // console.log('ufrag', remoteUfrag);
        // console.log('pwd', remotePwd);
        // console.log('self_ufrag', selfUfrag);
        // console.log('self_pwd', selfPwd);
    
        let sdp = '';
        sdp += 'v=0\r\n';
        sdp += 'o=- 0 0 IN IP4 127.0.0.1\r\n';
        sdp += 's=NODEPEER\r\n';
        sdp += 't=0 0\r\n';
        sdp += 'a=group:BUNDLE 0\r\n';
        // sdp += 'a=msid-semantic:WMS *\r\n';
        sdp += 'm=video 9 UDP/TLS/RTP/SAVP 96\r\n';
        sdp += 'a=mid:0\r\n'
        sdp += 'c=IN IP4 0.0.0.0\r\n';
        sdp += 'a=rtcp:9 IN IP4 0.0.0.0\r\n';
        sdp += 'a=ice-ufrag:' + selfUfrag + '\r\n';
        sdp += 'a=ice-pwd:' + selfPwd + '\r\n';
    
        if(certificateFPInOffer){
            const fp = this.formatFingerprint(await getFingerprintOfCertificate())
            console.log('our fingerprint', fp);
            sdp +=  (fp) + '\r\n';
        }

        sdp += 'a=setup:passive\r\n';
        
        for(const candidateStr of this.iceContext.getCandidates()){
            sdp += candidateStr;
        }

        sdp += `${selfDirection}\r\n`;
        sdp += 'a=rtcp-mux\r\n';
        sdp += 'a=rtcp-rsize\r\n';
        sdp += 'a=rtpmap:96 VP8/90000\r\n';

        sdp += 'a=rtcp-fb:96 nack\r\n';
        sdp += 'a=rtcp-fb:96 nack pli\r\n';

        const offeredExtensions = [];
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=extmap')) {
                offeredExtensions.push(line);
            }
        });
        console.log('Offered extensions:', offeredExtensions);

        const supportedExtensions = [
            'urn:ietf:params:rtp-hdrext:sdes:mid',
        ];

        const negotiatedExtensionsList = offeredExtensions.filter(offeredExtension => supportedExtensions.some(supportedExtension => offeredExtension.includes(supportedExtension)));

        console.log('Negotiated extensions:', negotiatedExtensionsList);



        // const midExtLine = offeredExtensions.find(ext => ext.includes('urn:ietf:params:rtp-hdrext:sdes:mid'));
        // if(midExtLine){
        //     sdp += midExtLine + '\r\n';
        // }
    

        if(globalThis.disableWebRTCEncryption){
            this.#srtpContext = new RTPContext({
                onPacketReadyToSend: this.iceContext.sendPacket.bind(this.iceContext),
                onRTPPacketReadyForApplication: this.#processPacket.bind(this),
                payloadTypes
            });
        }
        else{
            this.#srtpContext = new SRTPContext({
                onPacketReadyToSend: this.iceContext.sendPacket.bind(this.iceContext),
                onRTPPacketReadyForApplication: this.#processPacket.bind(this),
                payloadTypes
            });
            this.dtlsContext = new DTLSContext({onDTLSParamsReady: this.#srtpContext.initSRTP.bind(this.#srtpContext)});
        }


        return sdp;
    
    
    
    
    }

    async generateAnswer2(offer) {

        let sdp = '';
        sdp += 'v=0\r\n';
        sdp += 'o=- 0 0 IN IP4 127.0.0.1\r\n';
        sdp += 's=NODEPEER\r\n';
        sdp += 't=0 0\r\n';

        // 1. extract all the candidates from the offer
        const remoteCandidates = [];
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=candidate')) {
                remoteCandidates.push(line);
            }
        });

        // 2. Add the self candidate to answer
        for(const candidateStr of this.iceContext.getCandidates()){
            sdp += candidateStr;
        }

    
        // 3. Get remote ICE ufrag and pwd from the offer
        const remoteUfrag = offer.sdp.match(/a=ice-ufrag:(.*)/)[1];
        const remotePwd = offer.sdp.match(/a=ice-pwd:(.*)/)[1];
        this.iceContext.setRemoteUfragAndPassword(remoteUfrag, remotePwd);

        // 4. Add self ICE ufrag and pwd to answer
        const selfUfrag = this.iceContext.selfUfrag
        const selfPwd = this.iceContext.selfPwd
        sdp += 'a=ice-ufrag:' + selfUfrag + '\r\n';
        sdp += 'a=ice-pwd:' + selfPwd + '\r\n';

        
        const certificateFPInOffer = offer.sdp.match(/a=fingerprint:(.*)/);
        if(certificateFPInOffer){

            // 5. Get the certificate fingerprint from the offer
            const remoteCertificateFingerprint = certificateFPInOffer[1];
            this.dtlsContext = new DTLSContext({onDTLSParamsReady: this.handleDTLSParamsReady.bind(this)});
            this.dtlsContext.setRemoteFingerprint(remoteCertificateFingerprint);


            // 6. Add the self certificate fingerprint to answer
            const fp = this.formatFingerprint(await getFingerprintOfCertificate())
            console.log('our fingerprint', fp);
            sdp +=  (fp) + '\r\n';
        }
        else{
            if(globalThis.disableWebRTCEncryption){
                console.log('No fingerprint in the offer. Remote Peer wants no encryption')
            }
            else{
                throw new Error('Fingerprint not found in offer. Rejecting');
            }
        }


        
        const mBlocks = offer.sdp.split('m=').slice(1);
        for(const mBlock of mBlocks){
            const mediaType = mBlock.split(' ')[0];
            console.log('mBlock:', mediaType);

            const mid = mBlock.match(/a=mid:(.*)/)[1];
            const remoteDirection = mBlock.match(/a=sendrecv|a=recvonly|a=sendonly|a=inactive/)[0];
            const selfDirection = (remoteDirection == 'a=sendonly') ? 'a=recvonly' :
                                    (remoteDirection == 'a=recvonly') ? 'a=sendonly' :
                                    remoteDirection;

            const tx = new Transceiver(mid, mediaType, selfDirection);
            this.#transceivers[mid] = tx;


        }



    }

    handleDTLSParamsReady(params){
        this.#srtpContext.initSRTP(params);
    }

    formatFingerprint(hash) {
        // Format the hash as specified
        const formattedFingerprint = hash.match(/.{2}/g).join(':');
        return `a=fingerprint:sha-256 ${formattedFingerprint}`;
    }

    allocatePacketToAppropriateMethod(packet, remote){
        if(packet.at(0) == 0x16 && this.dtlsContext){
            const response = this.dtlsContext.handleDTLS(packet);
            this.iceContext.sendPacket(response, remote);
        }
        if(packet.at(0) >> 6 == 0x02){
            this.#srtpContext.handleIncomingPacketFromRemote(packet, remote);
        }
    }

    #processPacket(packet, sourceContext){
        const rtpPayloadType = packet.readUInt8(1) & 0b01111111;
        const rtcpPacketType = packet.readUInt8(1);

        if(rtpPayloadType >= 96 && rtpPayloadType <= 127){
            this.#handleRTPPacket(packet, sourceContext);
        }
        else if(rtcpPacketType >= 200 && rtcpPacketType <= 206){
            this.#handleRTCPPacket(packet, sourceContext)
            
        }
       
    }

    #handleRTPPacket(packet, sourceContext){
        const ssrc = packet.readUInt32BE(8);
        this.#initStreams(ssrc);

        //console.log('RTP SSRC:', ssrc);
        this.#remoteSSRCStreams[null].rtp.write(packet, sourceContext);
        this.#remoteSSRCStreams[ssrc].rtp.write(packet, sourceContext);
    }

    #handleRTCPPacket(packet, sourceContext){
        const lengthInBytes = (packet.readUInt16BE(2) + 1) * 4;
        //console.log(`\nRTCP packet arrived. length specified in packet: ${lengthInBytes}, bufferLength: ${packet.length}`);
        //console.log('RTCP packet:', packet);
        if(packet.length == lengthInBytes){
            this.#handleSingleRTCPPacket(packet);
        }
        else{
            let startIndex = 0;
            while(true){
                //console.log('startIndex:', startIndex);
                const rtpPacketLengthBytes = (packet.readUInt16BE(startIndex + 2) + 1) * 4;
                const rtpPacketBuffer = packet.slice(startIndex, startIndex + rtpPacketLengthBytes);

                this.#handleSingleRTCPPacket(rtpPacketBuffer, sourceContext);

                startIndex += rtpPacketLengthBytes;
                if(startIndex == packet.length){
                    break;
                }
            }
        }
    }

    #handleSingleRTCPPacket(packet, sourceContext){
        let ssrc;

        const packetType = packet.readUInt8(1) & 0b01111111;
        if(packetType == 201){
            ssrc = packet.readUInt32BE(8);
        }
        else{
            ssrc = packet.readUInt32BE(4);
        }

        this.#initStreams(ssrc);

        //console.log('RTCP SSRC:', ssrc);
        this.#remoteSSRCStreams[null].rtcpEvents.write(packet, sourceContext);
        this.#remoteSSRCStreams[ssrc].rtcpEvents.write(packet, sourceContext);
    }

    #initStreams(ssrc){
        if(!this.#remoteSSRCStreams[ssrc]){
            this.#remoteSSRCStreams[ssrc] = {
                rtp: new SimpleStream(),
                rtcpEvents: new SimpleStream()
            };
        }
    }

    subscribeToRTPStream(ssrc){
        console.log('Subscribing to RTP stream with ssrc', ssrc);
        this.#initStreams(ssrc);
        return this.#remoteSSRCStreams[ssrc].rtp;
    }

    subscribeToRTCPEventsStream(ssrc){
        console.log('Subscribing to RTCP Events stream with ssrc', ssrc);
        this.#initStreams(ssrc);
        return this.#remoteSSRCStreams[ssrc].rtcpEvents;
    }

    addRTPStream(stream){
        console.log('Adding RTP stream to peer context');
        stream.addEventListener('data', (data, sourceContext) => {
            //console.log('RTP from remote arrived, writing to wire..')
            this.#srtpContext.handleOutgoingPacketToRemote(data, sourceContext);
        })
    }

    addRTCPEventsStream(stream){
        console.log('Adding RTCP Events stream to peer context');
        stream.addEventListener('data', (data, sourceContext) => {
            //console.log('RTCP arrived, writing to wire..')
            this.#srtpContext.handleOutgoingPacketToRemote(data, sourceContext);
        })
    }

}

module.exports = {
    PeerContext
}