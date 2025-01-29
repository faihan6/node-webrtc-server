
const { ICEContext } = require('./stun');
const { DTLSContext, getFingerprintOfCertificate } = require('./dtls')
const { RTPContext } = require('./rtp');
const { SRTPContext } = require('./srtp');
const { SimpleStream } = require('../helpers/simple_stream');
const { Transceiver } = require('./transceiver');

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

    #dtlsContext = new DTLSContext();
    #srtpContext = new SRTPContext();

    #rtpContext = new RTPContext()


    #transceivers = {};

    #isUsingEncryption = true;

    constructor(){
        this.#dtlsContext.addEventListener('dtlsParamsReady', params => {
            this.#srtpContext.initSRTP(params);
        });

        this.#rtpContext.addEventListener('send_rtp_o_to_remote', packet => {
            const encryptedPacket = this.#srtpContext.encryptPacket(packet)
            this.iceContext.sendPacket(encryptedPacket);
        })

        this.#rtpContext.addEventListener('send_fb_i_to_remote', packet => {
            
            const encryptedPacket = this.#srtpContext.encryptPacket(packet)
            console.log('send_fb_i_to_remote event arrived', encryptedPacket.slice(15))
            this.iceContext.sendPacket(encryptedPacket);
        })
    }

    async generateAnswer(offer) {

        let answer = '';

        let vBlock = ''
        vBlock += 'v=0\r\n';
        vBlock += 'o=- 0 0 IN IP4 127.0.0.1\r\n';
        vBlock += 's=NODEPEER\r\n';
        vBlock += 't=0 0\r\n';

        let sessionAttributesBlock = ''

        // 1. extract all the candidates from the offer
        const remoteCandidates = [];
        offer.sdp.split('\r\n').forEach(line => {
            if (line.startsWith('a=candidate')) {
                remoteCandidates.push(line);
            }
        });

        // 2. Add the self candidate to answer
        for(const candidateStr of this.iceContext.getCandidates()){
            sessionAttributesBlock += candidateStr;
        }

    
        // 3. Get remote ICE ufrag and pwd from the offer
        const remoteUfrag = offer.sdp.match(/a=ice-ufrag:(.*)/)[1];
        const remotePwd = offer.sdp.match(/a=ice-pwd:(.*)/)[1];
        this.iceContext.setRemoteUfragAndPassword(remoteUfrag, remotePwd);

        // 4. Add self ICE ufrag and pwd to answer
        const selfUfrag = this.iceContext.selfUfrag
        const selfPwd = this.iceContext.selfPwd
        sessionAttributesBlock += 'a=ice-ufrag:' + selfUfrag + '\r\n';
        sessionAttributesBlock += 'a=ice-pwd:' + selfPwd + '\r\n';

        
        const certificateFPInOffer = offer.sdp.match(/a=fingerprint:(.*)/);
        if(certificateFPInOffer){

            // 5. Get the certificate fingerprint from the offer
            const remoteCertificateFingerprint = certificateFPInOffer[1];
            this.#dtlsContext.setRemoteFingerprint(remoteCertificateFingerprint);


            // 6. Add the self certificate fingerprint to answer
            const fp = this.formatFingerprint(await getFingerprintOfCertificate())
            console.log('our fingerprint', fp);
            sessionAttributesBlock +=  (fp) + '\r\n';

            // 6.1 add setup attribute
            sessionAttributesBlock += 'a=setup:passive\r\n';
        }
        else{
            if(globalThis.disableWebRTCEncryption){
                console.log('No fingerprint in the offer. Remote Peer wants no encryption')
            }
            else{
                throw new Error('Fingerprint not found in offer. Rejecting');
            }
        }


        let bundleLine = 'a=group:BUNDLE'
        
        const mBlocks = offer.sdp.split('m=').slice(1);
        for(let mBlock of mBlocks){
            // 7. populate the transceivers
            const mediaType = mBlock.split(' ')[0];
            console.log('mBlock:', mediaType);

            const mid = mBlock.match(/a=mid:(.*)/)[1];
            const remoteDirection = mBlock.match(/a=sendrecv|a=recvonly|a=sendonly|a=inactive/)[0];
            const selfDirection = (remoteDirection == 'a=sendonly') ? 'a=recvonly' :
                                    (remoteDirection == 'a=recvonly') ? 'a=sendonly' :
                                    remoteDirection;

            const payloadTypes = {};
            mBlock.split('\r\n').forEach(line => {
                if (line.startsWith('a=rtpmap')) {
                    const payloadType = line.match(/a=rtpmap:(\d+)/)[1];
                    const codec = line.split(' ')[1]
                    payloadTypes[payloadType] = codec;
                }
            });
            console.log(`mid: ${mid}, mediaType: ${mediaType}, remoteDirection: ${remoteDirection}, selfDirection: ${selfDirection}, payloadTypes:`, payloadTypes);

            const tx = new Transceiver({mid, mediaType, selfDirection, payloadTypes});
            this.#transceivers[mid] = tx;

            // 8. add m-blocks to answer
            // 8.1 replace remote direction with self direction
            mBlock = mBlock.replace(remoteDirection, selfDirection);
            
            // remove unwanted attributes
            mBlock = mBlock.split('\r\n').filter(line => {
                if (line.startsWith('a=rtcp-mux')) {
                    return true;
                }
                if (line.startsWith('a=rtcp-rsize')) {
                    return true;
                }
                if (line.startsWith('a=rtpmap')) {
                    return true;
                }
                if (line.startsWith('a=mid')) {
                    return true;
                }
                return false;
            }).join('\r\n');

            // 8.2 add m=
            const mLine = `m=${mediaType} 9 UDP/TLS/RTP/SAVPF ${Object.keys(payloadTypes).join(' ')}\r\n`;
            mBlock = mLine + mBlock

            answer += mBlock + '\r\n';

            // 8.3 add mid to BUNDLE
            bundleLine += ` ${mid}`


        }

        vBlock += bundleLine + '\r\n'


        answer = vBlock + answer + sessionAttributesBlock

        return answer;
    }

    formatFingerprint(hash) {
        // Format the hash as specified
        const formattedFingerprint = hash.match(/.{2}/g).join(':');
        return `a=fingerprint:sha-256 ${formattedFingerprint}`;
    }

    allocatePacketToAppropriateMethod(packet, remote){
        
        if(packet.at(0) == 0x16){
            // DTLS
            const response = this.#dtlsContext.handleDTLS(packet);
            this.iceContext.sendPacket(response, remote);
        }
        else if(packet.at(0) >> 6 == 0x02){
            
            const rtpPayloadType = packet.readUInt8(1) & 0b01111111;
            const rtcpPacketType = packet.readUInt8(1);

            const extensionsInfo = RTPContext.parseHeaderExtensions(packet);

            const decryptedPacket = this.#srtpContext.decryptPacket(packet, extensionsInfo);

            if((rtpPayloadType >= 96 && rtpPayloadType <= 127)){
                // RTP-i
                this.#rtpContext.handleRTPFromClient(decryptedPacket);
            }
            else{
                // SR-i and FB-o
                this.#rtpContext.handleFeedbackFromClient(decryptedPacket);
            }

            this.#incomingRTPDemuxer(packet);



        }
    }

    #incomingRTPDemuxer(packet){
        // identify mid from packet
        const mid = '0'

        const tx = this.#transceivers[mid];
        tx.handlePacketFromClient(packet);
    }

}

module.exports = {
    PeerContext
}