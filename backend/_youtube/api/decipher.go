package api

import (
	"fmt"
	"github.com/dop251/goja"
	"net/url"
)

func DecipherSignatureCipher(videoID string, cipher string) (string, error) {

	params, err := url.ParseQuery(cipher)
	if err != nil {
		return "", err
	}

	uri := params.Get("url")
	if err != nil {
		return "", err
	}

	/*	uri, err = url.QueryUnescape(uri)
		if err != nil {
			return "", err
		}*/

	resultUrl, err := url.Parse(uri)
	if err != nil {
		return "", nil
	}

	resultUrl, err = DecipherNsig(resultUrl, videoID)

	encrypted_sig := params.Get("s")
	sp := params.Get("sp")
	resultUrl, err = DecipherSig(resultUrl, encrypted_sig, sp, videoID)

	return resultUrl.String(), nil
}

func DecipherSig(uri *url.URL, signature string, key string, videoId string) (*url.URL, error) {

	playerInfo, err := GetPlayerInfo(videoId, nil)
	if err != nil {
		return uri, err
	}

	if signature != "" {

		vm := goja.New()

		_, err = vm.RunString(playerInfo.SigFunctionCode)
		if err != nil {
			return uri, err
		}
		// Run
		object := vm.Get(playerInfo.SigFunctionName)
		sigFunc, ok := goja.AssertFunction(object)
		if !ok {
			return uri, err
		}

		sigRes, err := sigFunc(nil, vm.ToValue(signature))
		if err != nil {
			return uri, err
		}

		if key == "" {
			key = "signature"
		}
		uri.RawQuery = fmt.Sprintf("%s&%s=%s", uri.RawQuery, key, sigRes.String())
	}
	return uri, nil
}

func DecipherNsig(uri *url.URL, videoId string) (*url.URL, error) {

	playerInfo, err := GetPlayerInfo(videoId, nil)
	if err != nil {
		return uri, err
	}

	resultQuery := uri.Query()

	vm := goja.New()
	n := resultQuery.Get("n")
	if n != "" {
		_, err = vm.RunString(playerInfo.NsigFunctionCode)
		if err != nil {
			return uri, err
		}
		// Run
		object := vm.Get(NSIG_FUNCTION_NAME)
		nsgiFunc, ok := goja.AssertFunction(object)
		if !ok {
			return uri, err
		}
		nsigRes, err := nsgiFunc(nil, vm.ToValue(fmt.Sprintf("%s", n)))
		if err != nil {
			return uri, err
		}
		resultQuery.Del("n")
		resultQuery.Add("n", nsigRes.String())
		uri.RawQuery = resultQuery.Encode()
	}
	return uri, nil
}
