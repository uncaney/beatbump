package api

import (
	"beatbump-server/backend/_youtube/api/auth"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var playerIdToPlayerInfo map[uint32]*PlayerInfo = make(map[uint32]*PlayerInfo)
var videoIdToPlayerInfo map[string]*PlayerInfo = make(map[string]*PlayerInfo)

type PlayerInfo struct {
	PlayerID           uint32
	NsigFunctionCode   string
	SigFunctionCode    string
	SigFunctionName    string
	SignatureTimestamp uint64
	HasPlayer          byte
	LastUpdate         time.Time
	InnerTubeContext   map[string]interface{}
}

// from https://github.com/iv-org/inv_sig_helper
var (
	TEST_YOUTUBE_VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw" // Replace with actual URL
	NSIG_FUNCTION_NAME = "decrypt_nsig"

	INNERTUBE_CONTEXT    = `"INNERTUBE_CONTEXT":\s*(\{.*?\}})`
	NSIG_FUNCTION_ARRAYS = []string{
		`null\)&&\([a-zA-Z]=(?P<nfunc>[a-zA-Z0-9$]+)\[(?P<idx>\d+)\]\([a-zA-Z0-9]\)`,
		`(?x)&&\(b="n+"\[[a-zA-Z0-9.+$]+\],c=a\.get\(b\)\)&&\(c=(?P<nfunc>[a-zA-Z0-9$]+)(?:\[(?P<idx>\d+)\])?\([a-zA-Z0-9]\)`,
	}
	NSIG_FUNCTION_ENDINGS = []string{
		`\s*=function\s*(\(\w\)\s*\{\s*var\s+\w=\w.split.*?\{\s*return"[a-zA-Z0-9_]+.?_w8_".*?\}\s*return\s+\w+\.join\(""\)\s*\}\s*;)`,
		`=\s*function([\S\s]*?\}\s*return \w+?\.join\(\"\"\)\s*\};)`,
		`=\s*function([\S\s]*?\}\s*return [\W\w$]+?\.call\([\w$]+?,\"\"\)\s*\};)`,
	}
	REGEX_PLAYER_ID          = "\\/s\\/player\\/([0-9a-f]{8})"                                                                            // Replace with actual regex for player ID
	REGEX_SIGNATURE_FUNCTION = `\s*?([a-zA-Z0-9_]{1,})=function\([a-zA-Z]{1}\)\{(.{1}=.{1}\.split\(""\)[^\}{]+)return .{1}\.join\(""\)\}` // Replace with actual regex for signature function
	REGEX_HELPER_OBJ_NAME    = `;([A-Za-z0-9_\\$]{2,})\...\(`

	REGEX_SIGNATURE_TIMESTAMP = `signatureTimestamp[=:](\d+)` // Replace with actual regex for signature timestamp
)

func fixupNsigJsCode(jscode string) string {
	// Compile the regular expression in Go
	fixupRe := regexp.MustCompile(`;\s*if\s*\(\s*typeof\s+[a-zA-Z0-9_$]+\s*===?\s*"undefined"\s*\)\s*return\s+\w+;`)

	// Check if the regex matches
	if fixupRe.MatchString(jscode) {
		//log.Println("Fixing up nsig_func_body.")
		// Replace the matched pattern with just ";"
		return fixupRe.ReplaceAllString(jscode, ";")
	} else {
		log.Println("nsig_func returned with no fixup")
		return jscode
	}
}

func GetPlayerInfo(videoId string, auth *auth.Auth) (*PlayerInfo, error) {

	videoId = "l6_w3887Rwo"

	if videoConfig, ok := videoIdToPlayerInfo[videoId]; ok {
		return videoConfig, nil
	}

	// Step 1: Fetch the test video HTML response
	playerJSBody, playerId, inntertubeJson, err := getPlayerConfigJS(videoId, auth)

	if err != nil {
		return nil, err
	}

	if videoConfig, ok := playerIdToPlayerInfo[uint32(playerId)]; ok {
		return videoConfig, nil
	}

	nsigFunctionCode, err := parseNsigParams(playerJSBody)
	if err != nil {
		return nil, err
	}

	signatureFunctionName, sigCode, err := parseSigFunction(playerJSBody)
	if err != nil {
		return nil, err
	}

	// Step 10: Extract the signature timestamp
	signatureTimestampMatches := regexp.MustCompile(REGEX_SIGNATURE_TIMESTAMP).FindStringSubmatch(string(playerJSBody))
	signatureTimestamp, _ := strconv.ParseUint(signatureTimestampMatches[1], 10, 64)

	innertubeContext := make(map[string]interface{})
	json.Unmarshal([]byte(inntertubeJson), &innertubeContext)

	// Step 11: Update the global playerIdToPlayerInfo with the new player info
	playerInfo := PlayerInfo{}
	playerInfo.PlayerID = uint32(playerId)
	playerInfo.NsigFunctionCode = nsigFunctionCode
	playerInfo.SigFunctionCode = sigCode
	playerInfo.SigFunctionName = signatureFunctionName
	playerInfo.SignatureTimestamp = signatureTimestamp
	playerInfo.InnerTubeContext = innertubeContext
	playerInfo.HasPlayer = 0xFF
	playerInfo.LastUpdate = time.Now()

	videoIdToPlayerInfo[videoId] = &playerInfo
	playerIdToPlayerInfo[uint32(playerId)] = &playerInfo

	return &playerInfo, nil
}

func parseSigFunction(playerJSBody string) (string, string, error) {
	// Step 8: Extract signature function and helper object
	signatureFunctionName := regexp.MustCompile(REGEX_SIGNATURE_FUNCTION).FindStringSubmatch(string(playerJSBody))[1]

	// Step 8: Extract signature function name and body
	// Build the regex string dynamically
	sigFunctionBodyRegexStr := fmt.Sprintf(`(?ms)%s=function\([a-zA-Z0-9_]+\)\{.+?\}`, strings.ReplaceAll(signatureFunctionName, "$", "\\$"))
	sigFunctionBodyRegex := regexp.MustCompile(sigFunctionBodyRegexStr)

	// Find the function body using the regex
	sigFunctionBodyMatches := sigFunctionBodyRegex.FindStringSubmatch(string(playerJSBody))
	if len(sigFunctionBodyMatches) < 1 {
		return "", "", fmt.Errorf("could not find signature function body")
	}
	sigFunctionBody := sigFunctionBodyMatches[0]

	// Step 9: Extract helper object name and body
	// Extract the helper object name from the sig function body
	helperObjectMatches := regexp.MustCompile(REGEX_HELPER_OBJ_NAME).FindStringSubmatch(sigFunctionBody)
	if len(helperObjectMatches) < 2 {
		return "", "", fmt.Errorf("could not extract helper object name")
	}
	helperObjectName := helperObjectMatches[1]

	// Now build the regex to capture the entire helper object body
	helperObjectBodyRegexStr := fmt.Sprintf(`(var %s=\{(?:.|\n)+?\}\};)`, helperObjectName)
	helperObjectBodyRegex := regexp.MustCompile(helperObjectBodyRegexStr)

	// Find the helper object body
	helperObjectBodyMatches := helperObjectBodyRegex.FindStringSubmatch(string(playerJSBody))
	if len(helperObjectBodyMatches) < 1 {
		return "", "", fmt.Errorf("could not extract helper object body")
	}
	helperObjectBody := helperObjectBodyMatches[0]

	// Step 10: Build the final signature code
	sigCode := fmt.Sprintf("var %s; %s %s", signatureFunctionName, helperObjectBody, sigFunctionBody)
	return signatureFunctionName, sigCode, nil
}

func parseNsigParams(playerJSBody string) (string, error) {
	var nsigFunctionArrayOpt []string
	// Extract nsig function array code
	for index, nsigFunctionArrayStr := range NSIG_FUNCTION_ARRAYS {
		nsigFunctionArrayRegex, err := regexp.Compile(nsigFunctionArrayStr)
		if err != nil {
			log.Printf("Error compiling nsig function array regex: %s", nsigFunctionArrayStr)
			continue
		}

		matches := nsigFunctionArrayRegex.FindStringSubmatch(playerJSBody)
		if matches == nil {
			log.Printf("nsig function array did not work: %s", nsigFunctionArrayStr)
			if index == len(NSIG_FUNCTION_ARRAYS)-1 {
				log.Println("!!ERROR!! nsig function array unable to be extracted")
				return "", errors.New("failed")
			}
			continue
		} else {
			nsigFunctionArrayOpt = matches
		}
		//

		break
	}

	if nsigFunctionArrayOpt == nil {
		return "", errors.New("unable to find a valid nsig function array")
	}

	// Extract the values for nfunc and idx from the match
	nsigArrayName := nsigFunctionArrayOpt[1]
	nsigArrayValue, err := strconv.Atoi(nsigFunctionArrayOpt[2])

	if err != nil {
		return "", err
	}

	// Generate regex for nsig array context
	nsigArrayContextRegex := fmt.Sprintf("var %s%s", strings.ReplaceAll(nsigArrayName, "$", "\\$"), `\s*=\s*\[(.+?)][;,]`)
	nsigArrayContext, err := regexp.Compile(nsigArrayContextRegex)
	if err != nil {
		log.Printf("Error: nsig regex compilation failed: %v", err)
		return "", err
	}

	// Extract the array content
	matches := nsigArrayContext.FindStringSubmatch(playerJSBody)
	if matches == nil {
		return "", errors.New("unable to find nsig array context")
	}
	arrayContent := matches[1]

	arrayValues := strings.Split(arrayContent, ",")

	nsigFunctionName := arrayValues[nsigArrayValue]

	// Prepare to extract nsig function code
	var nsigFunctionCode string
	nsigFunctionCode = "function " + NSIG_FUNCTION_NAME

	// Extract nsig function code
	for index, ending := range NSIG_FUNCTION_ENDINGS {
		nsigFunctionCodeRegexStr := fmt.Sprintf("(?ms)%s%s", regexp.QuoteMeta(nsigFunctionName), ending)
		nsigFunctionCodeRegex, err := regexp.Compile(nsigFunctionCodeRegexStr)
		if err != nil {
			log.Printf("Error compiling nsig function code regex: %v", err)
			continue
		}

		matches := nsigFunctionCodeRegex.FindStringSubmatch(playerJSBody)
		if matches == nil {
			log.Printf("nsig function ending did not work: %s", ending)
			if index == len(NSIG_FUNCTION_ENDINGS)-1 {
				log.Println("!!ERROR!! nsig function unable to be extracted")
				return "", errors.New("")
			}
			continue
		}

		nsigFunctionCode += matches[1]
		nsigFunctionCode = fixupNsigJsCode(nsigFunctionCode)
		//log.Printf("Got nsig function code: %s", nsigFunctionCode)
		break
	}
	return nsigFunctionCode, nil
}

func getPlayerConfigJS(videoId string, authObj *auth.Auth) (string, uint64, string, error) {
	watchPageBody, err := DownloadWebpage("https://music.youtube.com/watch?v="+videoId, WebMusic, authObj)

	// Step 2: Extract player ID using regex
	watchWebPage := string(watchPageBody)
	playerIDMatches := regexp.MustCompile(REGEX_PLAYER_ID).FindStringSubmatch(watchWebPage)
	if len(playerIDMatches) < 2 {
		return "", 0, "", errors.New("unable to extract player id")
	}
	playerIDStr := playerIDMatches[1]

	inntertubeMatches := regexp.MustCompile(INNERTUBE_CONTEXT).FindStringSubmatch(watchWebPage)
	if len(playerIDMatches) < 2 {
		return "", 0, "", errors.New("unable to extract visitor data")
	}
	inntertubeJson := inntertubeMatches[1]

	// Step 3: Convert player ID from hexadecimal to uint32
	playerID, err := strconv.ParseUint(playerIDStr, 16, 32)
	if err != nil {
		return "", 0, "", err
	}

	// Step 5: Fetch the player JS code
	playerJSURL := fmt.Sprintf("https://www.youtube.com/s/player/%08x/player_ias.vflset/en_US/base.js", playerID)

	playerJSBodyBytes, err := DownloadWebpage(playerJSURL, WebMusic, authObj)

	return string(playerJSBodyBytes), playerID, inntertubeJson, nil

}

func main() {
	url := "https://rr1---sn-o097znz7.googlevideo.com/videoplayback?bui=AfMhrI_zD0-LZdnYckvQh13CFBiUeV1Hdjb7kHhEW9g6i81S3W5IQHFf6pjnkqK5XCNufkTU6A&c=WEB_REMIX&clen=5551238&dur=342.857&ei=uOl0Z_jDKMqYsfIPkLSRWA&expire=1735736856&fexp=51326932%2C51335594&fvip=4&gcr=us&gir=yes&id=o-AH5w7fdmgsFLTZRHwifdcFmb16lhicXhiDy8uz_40dC_&initcwndbps=4558750&ip=24.23.145.248&itag=140&keepalive=yes&lmt=1680938387636089&lsig=AGluJ3MwRgIhALbhzvJ7trM4VWw4lCX37i5UAcrz9wCKVbXRSK0Ufeg1AiEAv9cY4htVZ6Tspv8O2X17t5NI8zc34FKewV8LB9WFV-8%3D&lsparams=met%2Cmh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpl%2Crms%2Cinitcwndbps&met=1735715256%2C&mh=Fp&mime=audio%2Fmp4&mm=31%2C26&mn=sn-o097znz7%2Csn-a5m7lnld&ms=au%2Conr&mt=1735714874&mv=m&mvi=1&n=gCh9oD0yySETtw&ns=ryzXhmLglPX7XsZXVQfjJCwQ&pcm2=yes&pl=24&ratebypass=yes&requiressl=yes&rms=au%2Cau&rqh=1&sefc=1&siu=1&source=youtube&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Cxpc%2Cpcm2%2Cgcr%2Csiu%2Cbui%2Cspc%2Cvprv%2Csvpuc%2Cmime%2Cns%2Crqh%2Cgir%2Cclen%2Cratebypass%2Cdur%2Clmt&spc=x-caUAUczZ-OQ9cMbLE1Bd395T_XsofnJXGXX6aSlirlMzC6whKk47ebqsrEUGC_s9NxsvXvIJ6Q&svpuc=1&txp=2311224&vprv=1&xpc=EgVo2aDSNQ%3D%3D&sig=AJfQdSswRgIhALhwwALjQ704LsQEYWgB8vM4rPsQXnweB-prKt2Ob958AiEA99CsrQZIGPd4Q8kDUs0aSqQ9hwhGMe6oPzVG7eiZ__c="

	req, err := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0")
	// Create a client and send the request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error sending request:", err)
		panic(1)
	}

	if resp.StatusCode != 200 {
		panic(1)
	}

	defer resp.Body.Close()

	_, err = io.ReadAll(resp.Body)
	status, err := GetPlayerInfo("jNQXAC9IVRw", nil)
	if err != nil {
		log.Fatalf("Error: %v", err)
	}
	fmt.Println("Update status:", status)
}
