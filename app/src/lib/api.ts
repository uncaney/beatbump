import { SERVER_DOMAIN } from "../env";

// Marks a player.json call that is NOT a playback start (queue warm-up,
// save-for-offline resolution, share-page preview, getMoreLikeThis): the backend
// serves it identically but triggers no server-side acquisition (F12).
export const PREFETCH_INIT: RequestInit = { headers: { "X-Ytm-Prefetch": "1" } };

export const APIClient = {
    fetch: (url: string, init?: RequestInit): Promise<any> => {
        // Plain-object headers only (that is what every caller passes).
        const headers: Record<string, string> = { ...((init && init.headers) as Record<string, string> | undefined) }

        // add the headers to the options
        let uri = `${SERVER_DOMAIN}` + url;
        return fetch(uri, { ...init, headers: headers, credentials: 'same-origin' })
    },
    post: (url: string, body?: any): Promise<any> => {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        }

        let uri = `${SERVER_DOMAIN}` + url;
        return fetch(uri, {
            method: 'POST',
            headers: headers,
            credentials: 'same-origin',
            body: JSON.stringify(body)
        })
    },
    del: (url: string): Promise<any> => {
        const headers: Record<string, string> = {}
        let uri = `${SERVER_DOMAIN}` + url;
        return fetch(uri, {
            method: 'DELETE',
            headers: headers,
            credentials: 'same-origin'
        })
    }
};
