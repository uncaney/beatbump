import {SERVER_DOMAIN} from "../env";


export const APIClient = {
    fetch: (url: string): Promise<Response> => {
        const headers: Record<string, string> = {}
        let cookieHeader = localStorage.getItem('x-google-cookie');
        let clientSecret = localStorage.getItem('x-google-client-secret');
        let clinetId = localStorage.getItem('x-google-client-id');
        if (cookieHeader != undefined && cookieHeader != "") {
            headers["X-Google-Cookie"] = cookieHeader || ""
        }
        if (clinetId != undefined && clinetId != "") {
            headers["x-google-client-id"] = clinetId || ""
        }
        if (clientSecret != undefined && clientSecret != "") {
            headers["x-google-client-secret"] = clientSecret || ""
        }
        // add the headers to the options
        let uri = `${SERVER_DOMAIN}` + url;
        return fetch(uri, {headers: headers, credentials: 'same-origin'})
    }
};
