package auth

import (
	"encoding/base64"
	"encoding/json"
	"github.com/labstack/echo/v4"
	"net/http"
	"time"
)

func Cookie(c echo.Context) error {
	var cookieMap = getJSONRawBody(c)
	value := cookieMap["cookie"]
	setCookieValue(c, value)
	return c.JSON(200, "OK")
}

func setCookieValue(c echo.Context, cookieValue string) {
	cookie := new(http.Cookie)
	cookie.Name = "cookie"
	cookie.Value = base64.StdEncoding.EncodeToString([]byte(cookieValue))
	cookie.Secure = false
	cookie.HttpOnly = true
	cookie.Path = "/"
	cookie.Expires = time.Now().Add(time.Hour * 24 * 30 * 6)
	cookie.SameSite = http.SameSiteDefaultMode
	//cookie.Expires = time.Now().Add(24 * time.Hour)
	c.SetCookie(cookie)
}

func getJSONRawBody(c echo.Context) map[string]string {

	jsonBody := make(map[string]string)
	err := json.NewDecoder(c.Request().Body).Decode(&jsonBody)
	if err != nil {
		return nil
	}

	return jsonBody
}
