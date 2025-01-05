package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
	"io/ioutil"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	scopes              = "https://www.googleapis.com/auth/youtube"
	TokenURL            = "https://www.youtube.com/o/oauth2/token"
	oauth2DeviceCodeURL = "https://www.youtube.com/o/oauth2/device/code"
)

var pendingTokens = map[string]context.Context{}

type YouTubeOAuth2Handler struct {
	token oauth2.Token
}

func isTokenValid(token oauth2.Token) bool {
	fieldValidation := token.AccessToken != "" && token.TokenType != "" && token.RefreshToken != ""
	if fieldValidation {
		//return c.JSON(http.StatusOK, output)
		url := "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"

		// Create a Bearer string by appending string access token
		var bearer = token.TokenType + " " + token.AccessToken

		// Create a new request using http
		req, err := http.NewRequest("GET", url, nil)

		// add authorization header to the req
		req.Header.Add("Authorization", bearer)

		// Send req using http Client
		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			log.Println("Error on response.\n[ERROR] -", err)
		}
		defer resp.Body.Close()

		return resp.StatusCode == 200
	}
	return false
}

func RefreshToken(refreshToken string, clientId string, clientSecret string) (oauth2.Token, error) {
	data := map[string]string{
		"client_id":     clientId,
		"client_secret": clientSecret,
		"refresh_token": refreshToken,
		"grant_type":    "refresh_token",
	}

	payload, err := json.Marshal(data)
	if err != nil {
		return oauth2.Token{}, err
	}

	resp, err := http.Post(TokenURL, "application/json", bytes.NewBuffer(payload))
	if err != nil {
		return oauth2.Token{}, err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return oauth2.Token{}, err
	}

	var token oauth2.Token
	if err := json.Unmarshal(body, &token); err != nil {
		return oauth2.Token{}, err
	}

	if token.AccessToken == "" {
		return oauth2.Token{}, fmt.Errorf("failed to refresh access token")
	}
	values := map[string]interface{}{}
	err = json.Unmarshal(body, &values)
	if err != nil {
		return oauth2.Token{}, err
	}
	token.RefreshToken = refreshToken
	token.Expiry = time.Now().UTC().Add(time.Second * time.Duration(values["expires_in"].(float64)))
	return token, nil
}

func DeviceOauth(c echo.Context) error {
	clientSecret := c.Request().Header.Get("x-google-client-secret")
	clientId := c.Request().Header.Get("x-google-client-id")
	if clientId == "" || clientSecret == "" {
		output := map[string]string{}
		output["status"] = "Update the Oauth client id/secret and refresh the page to begin the OAuth flow"
		return c.JSON(http.StatusOK, output)
	}
	tokenObj := extractAndValidateToken(clientId, clientSecret, c)

	if tokenObj != nil {
		output := map[string]string{}
		output["loggedIn"] = "true"

		return c.JSON(http.StatusOK, output)
	}

	return beginOauthflow(clientId, clientSecret, c)
}

func beginOauthflow(clientId string, clientSecret string, c echo.Context) error {
	//delete old token
	deleteTokenInCookie(c)

	data := map[string]string{
		"client_id": clientId,
		"scope":     scopes,
		"device_id": uuid.New().String(),
		//"device_model": "ytlr::",
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	resp, err := http.Post(oauth2DeviceCodeURL, "application/json", bytes.NewBuffer(payload))
	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return c.String(http.StatusInternalServerError, "failed to initiate oauth "+resp.Status)
	}

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	var codeResponse struct {
		VerificationURL string `json:"verification_url"`
		UserCode        string `json:"user_code"`
		DeviceCode      string `json:"device_code"`
		Interval        int    `json:"interval"`
	}
	if err := json.Unmarshal(body, &codeResponse); err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	//authorize(codeResponse.DeviceCode,codeResponse.Interval)
	output := map[string]string{}
	output["oauthStart"] = fmt.Sprintf("%s?user_code=%s", codeResponse.VerificationURL, codeResponse.UserCode)
	output["deviceCode"] = codeResponse.DeviceCode
	return c.JSON(http.StatusOK, output)
}

func AuthorizeOauth(c echo.Context) error {
	deviceCode := c.Param("deviceCode")
	clientSecret := c.Request().Header.Get("x-google-client-secret")
	clientId := c.Request().Header.Get("x-google-client-id")
	if clientId == "" || clientSecret == "" {
		return c.JSON(http.StatusBadRequest, "missing client secret / id")
	}
	token, err := authorize(clientId, clientSecret, deviceCode, 5)

	if err != nil {
		return c.JSON(http.StatusInternalServerError, err)
	}
	storeTokenInCookie(c, *token)

	return c.JSON(http.StatusOK, token)
}

// Function to extract the base domain (without subdomains)
func extractBaseDomain(hostname string) string {
	// Split the hostname by dots
	parts := strings.Split(hostname, ".")

	// Check if the parts of the hostname are at least two (i.e., domain + TLD)
	if len(parts) > 2 {
		// Extract the last two parts for the base domain
		return strings.Join(parts[len(parts)-2:], ".")
	}
	// Return the hostname as is if it's already a single domain
	return hostname
}

func storeTokenInCookie(c echo.Context, token oauth2.Token) {

	// Extract the hostname from the parsed URL

	tokenJson, _ := json.Marshal(token)
	cookie := new(http.Cookie)
	cookie.Name = "token"
	cookie.Value = base64.StdEncoding.EncodeToString(tokenJson)
	cookie.Secure = false
	cookie.HttpOnly = true
	cookie.Path = "/"
	cookie.Domain = ""
	cookie.Expires = time.Now().Add(time.Hour * 24 * 30)
	cookie.SameSite = http.SameSiteDefaultMode
	//cookie.Expires = time.Now().Add(24 * time.Hour)
	referer := c.Request().Header.Get("Referer")
	if referer != "" {

		// Parse the referer URL
		parsedURL, _ := url.Parse(referer)
		domain := extractBaseDomain(parsedURL.Hostname())
		cookie.Domain = domain
	}
	c.SetCookie(cookie)
}

func deleteTokenInCookie(c echo.Context) {
	cookie := new(http.Cookie)
	cookie.Name = "token"
	cookie.Value = ""
	cookie.Secure = false
	cookie.HttpOnly = true
	cookie.Path = "/api"
	cookie.Expires = time.Unix(0, 0)
	cookie.SameSite = http.SameSiteDefaultMode
	referer := c.Request().Header.Get("Referer")
	if referer != "" {

		// Parse the referer URL
		parsedURL, _ := url.Parse(referer)
		domain := extractBaseDomain(parsedURL.Hostname())
		cookie.Domain = domain
	}
	c.SetCookie(cookie)
}

func authorize(clientId string, clientSecret string, deviceCode string, interval int) (*oauth2.Token, error) {

	if currcontext, ok := pendingTokens[deviceCode]; ok {
		if currcontext != nil {
			currcontext.Done()
		}
	}
	data := map[string]string{
		"client_id":     clientId,
		"client_secret": clientSecret,
		"code":          deviceCode,
		"grant_type":    "http://oauth.net/grant_type/device/1.0",
	}

	payload, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	if interval == 0 {
		interval = 5
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute*1)
	pendingTokens[deviceCode] = ctx
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer func() {
		pendingTokens[deviceCode] = nil
		ticker.Stop()
	}()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			tok, err := retrieveToken(payload)
			if err == nil {
				return tok, nil
			}
			if err.Error() == "expired_token" {
				cancel()
			}
		}
	}

	return nil, errors.New("failed to get token")
}

func retrieveToken(payload []byte) (*oauth2.Token, error) {
	resp, err := http.Post(TokenURL, "application/json", bytes.NewBuffer(payload))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var token oauth2.Token
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, err
	}

	if token.AccessToken != "" {
		values := map[string]interface{}{}
		json.Unmarshal(body, &values)
		token.Expiry = time.Now().UTC().Add(time.Second * time.Duration(values["expires_in"].(float64)))
		fmt.Println("Authorization successful")
		return &token, nil
	}

	// Handle specific OAuth errors
	var errorResponse struct {
		Error string `json:"error"`
	}
	err = json.Unmarshal(body, &errorResponse)

	if err != nil {
		return nil, err
	}

	return nil, errors.New(errorResponse.Error)
}

func extractAndValidateToken(clientId string, clientSecret string, c echo.Context) *oauth2.Token {
	tokenCookie, _ := c.Cookie("token")
	tokenObj := oauth2.Token{}
	if tokenCookie != nil {
		tokenJson, _ := base64.StdEncoding.DecodeString(tokenCookie.Value)
		_ = json.Unmarshal([]byte(tokenJson), &tokenObj)
		if isTokenValid(tokenObj) {
			return &tokenObj
		} else {
			tokenObj, err := RefreshToken(tokenObj.RefreshToken, clientId, clientSecret)
			if err != nil {
				return nil
			}
			//update cookie
			storeTokenInCookie(c, tokenObj)
			return &tokenObj
		}
	}
	return nil
}
