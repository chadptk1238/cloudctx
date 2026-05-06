// Vendored from `youtube-transcript` v1.3.1 (npm) on 2026-05-05.
// Source: https://github.com/Kakulukian/youtube-transcript
// License: MIT — see ./NOTICE
//
// Why vendored: cloudctx ships as a global CLI; pulling a transitive npm
// dep at install time creates a supply-chain risk we can eliminate by
// inlining this 10KB of pure JS. To update: re-copy `dist/esm/index.js`
// from a fresh `npm install youtube-transcript@<new>` and diff before
// committing.

const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_CONTEXT = {
    client: {
        clientName: 'ANDROID',
        clientVersion: INNERTUBE_CLIENT_VERSION,
    },
};
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;
export class YoutubeTranscriptError extends Error {
    constructor(message) {
        super(`[YoutubeTranscript] 🚨 ${message}`);
    }
}
export class YoutubeTranscriptTooManyRequestError extends YoutubeTranscriptError {
    constructor() {
        super('YouTube is receiving too many requests from this IP and now requires solving a captcha to continue');
    }
}
export class YoutubeTranscriptVideoUnavailableError extends YoutubeTranscriptError {
    constructor(videoId) {
        super(`The video is no longer available (${videoId})`);
    }
}
export class YoutubeTranscriptDisabledError extends YoutubeTranscriptError {
    constructor(videoId) {
        super(`Transcript is disabled on this video (${videoId})`);
    }
}
export class YoutubeTranscriptNotAvailableError extends YoutubeTranscriptError {
    constructor(videoId) {
        super(`No transcripts are available for this video (${videoId})`);
    }
}
export class YoutubeTranscriptNotAvailableLanguageError extends YoutubeTranscriptError {
    constructor(lang, availableLangs, videoId) {
        super(`No transcripts are available in ${lang} this video (${videoId}). Available languages: ${availableLangs.join(', ')}`);
    }
}
/**
 * Class to retrieve transcript if exist
 */
export class YoutubeTranscript {
    /**
     * Fetch transcript from YTB Video
     * @param videoId Video url or video identifier
     * @param config Get transcript in a specific language ISO
     */
    static async fetchTranscript(videoId, config) {
        const identifier = this.retrieveVideoId(videoId);
        // Try InnerTube API first
        const innerTubeResult = await this.fetchViaInnerTube(identifier, config);
        if (innerTubeResult) {
            return innerTubeResult;
        }
        // Fall back to HTML scraping
        return this.fetchViaWebPage(identifier, videoId, config);
    }
    /**
     * Fetch transcript via the InnerTube API (Android client context)
     */
    static async fetchViaInnerTube(identifier, config) {
        try {
            const fetchFn = config?.fetch ?? fetch;
            const resp = await fetchFn(INNERTUBE_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': INNERTUBE_USER_AGENT,
                },
                body: JSON.stringify({
                    context: INNERTUBE_CONTEXT,
                    videoId: identifier,
                }),
            });
            if (!resp.ok)
                return undefined;
            const data = await resp.json();
            const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
                return undefined;
            }
            return this.fetchTranscriptFromTracks(captionTracks, identifier, config);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Fetch transcript via web page HTML scraping (fallback)
     */
    static async fetchViaWebPage(identifier, originalVideoId, config) {
        const fetchFn = config?.fetch ?? fetch;
        const videoPageResponse = await fetchFn(`https://www.youtube.com/watch?v=${identifier}`, {
            headers: {
                ...(config?.lang && { 'Accept-Language': config.lang }),
                'User-Agent': USER_AGENT,
            },
        });
        const videoPageBody = await videoPageResponse.text();
        if (videoPageBody.includes('class="g-recaptcha"')) {
            throw new YoutubeTranscriptTooManyRequestError();
        }
        if (!videoPageBody.includes('"playabilityStatus":')) {
            throw new YoutubeTranscriptVideoUnavailableError(originalVideoId);
        }
        const playerResponse = this.parseInlineJson(videoPageBody, 'ytInitialPlayerResponse');
        const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
            throw new YoutubeTranscriptDisabledError(originalVideoId);
        }
        return this.fetchTranscriptFromTracks(captionTracks, originalVideoId, config);
    }
    /**
     * Extract a JSON object assigned to a global variable in inline script tags
     */
    static parseInlineJson(html, globalName) {
        const startToken = `var ${globalName} = `;
        const startIndex = html.indexOf(startToken);
        if (startIndex === -1)
            return null;
        const jsonStart = startIndex + startToken.length;
        let depth = 0;
        for (let i = jsonStart; i < html.length; i++) {
            if (html[i] === '{')
                depth++;
            else if (html[i] === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        return JSON.parse(html.slice(jsonStart, i + 1));
                    }
                    catch {
                        return null;
                    }
                }
            }
        }
        return null;
    }
    /**
     * Given caption tracks, select the right one, fetch and parse the transcript XML
     */
    static async fetchTranscriptFromTracks(captionTracks, videoId, config) {
        if (config?.lang &&
            !captionTracks.some((track) => track.languageCode === config?.lang)) {
            throw new YoutubeTranscriptNotAvailableLanguageError(config?.lang, captionTracks.map((track) => track.languageCode), videoId);
        }
        const track = config?.lang
            ? captionTracks.find((track) => track.languageCode === config?.lang)
            : captionTracks[0];
        const transcriptURL = track.baseUrl;
        // Validate URL to prevent SSRF
        try {
            const captionUrl = new URL(transcriptURL);
            if (!captionUrl.hostname.endsWith('.youtube.com')) {
                throw new YoutubeTranscriptNotAvailableError(videoId);
            }
        }
        catch (e) {
            if (e instanceof YoutubeTranscriptError)
                throw e;
            throw new YoutubeTranscriptNotAvailableError(videoId);
        }
        const fetchFn = config?.fetch ?? fetch;
        const transcriptResponse = await fetchFn(transcriptURL, {
            headers: {
                ...(config?.lang && { 'Accept-Language': config.lang }),
                'User-Agent': USER_AGENT,
            },
        });
        if (!transcriptResponse.ok) {
            throw new YoutubeTranscriptNotAvailableError(videoId);
        }
        const transcriptBody = await transcriptResponse.text();
        const lang = config?.lang ?? captionTracks[0].languageCode;
        return this.parseTranscriptXml(transcriptBody, lang);
    }
    /**
     * Parse transcript XML, supporting both srv3 format (<p t="ms">) and
     * classic format (<text start="s" dur="s">)
     */
    static parseTranscriptXml(xml, lang) {
        const results = [];
        // Try srv3 format first: <p t="ms" d="ms"><s>word</s>...</p>
        const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
        let match;
        while ((match = pRegex.exec(xml)) !== null) {
            const startMs = parseInt(match[1], 10);
            const durMs = parseInt(match[2], 10);
            const inner = match[3];
            let text = '';
            const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
            let sMatch;
            while ((sMatch = sRegex.exec(inner)) !== null) {
                text += sMatch[1];
            }
            if (!text) {
                text = inner.replace(/<[^>]+>/g, '');
            }
            text = this.decodeEntities(text).trim();
            if (text) {
                results.push({
                    text,
                    duration: durMs,
                    offset: startMs,
                    lang,
                });
            }
        }
        if (results.length > 0)
            return results;
        // Fall back to classic format: <text start="s" dur="s">content</text>
        const classicResults = [...xml.matchAll(RE_XML_TRANSCRIPT)];
        return classicResults.map((result) => ({
            text: this.decodeEntities(result[3]),
            duration: parseFloat(result[2]),
            offset: parseFloat(result[1]),
            lang,
        }));
    }
    /**
     * Decode common HTML entities in transcript text
     */
    static decodeEntities(text) {
        return text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
    }
    /**
     * Retrieve video id from url or string
     * @param videoId video url or video id
     */
    static retrieveVideoId(videoId) {
        if (videoId.length === 11) {
            return videoId;
        }
        const matchId = videoId.match(RE_YOUTUBE);
        if (matchId && matchId.length) {
            return matchId[1];
        }
        throw new YoutubeTranscriptError('Impossible to retrieve Youtube video ID.');
    }
}
//^ class is kept for backward compatibility
export function fetchTranscript(videoId, config) {
    return YoutubeTranscript.fetchTranscript(videoId, config);
}
