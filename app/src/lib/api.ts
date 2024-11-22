
import { SERVER_DOMAIN } from "../env";


export const APIClient = {
	fetch: (url: string): Promise<Response> => {

        const headers :Record<string, string> = {
            "X-Google-Cookie": localStorage.getItem('x-google-cookie') || ""
        }
        // add the headers to the options
        return fetch(`${SERVER_DOMAIN}`+url, {headers:headers})
	}
};
