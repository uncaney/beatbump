import type { Body, Context } from "./types";



/** Helper function to build a request body
	consisting of Context and params of type `T` */
function buildRequestBody<T>(context: Context, params: Body<T>) {
	return Object.assign({}, { context }, params);
}
