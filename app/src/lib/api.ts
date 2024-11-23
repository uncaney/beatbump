import {SERVER_DOMAIN} from "../env";


export const APIClient = {
    fetch: (url: string): Promise<Response> => {
        const headers: Record<string, string> = {}
        let cookieHeader = localStorage.getItem('x-google-cookie');
        if (cookieHeader != undefined && cookieHeader != "") {
            headers["X-Google-Cookie"] = cookieHeader || ""
        }
        // add the headers to the options
        return fetch(`${SERVER_DOMAIN}` + url, {headers: headers, credentials: 'same-origin'})
    }
};
