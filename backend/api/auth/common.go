package auth

import (
	"fmt"
	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
)

const (
	AUTH_TYPE_NONE = iota
	AUTH_TYPE_OAUTH
	AUTH_TYPE_COOKIES
)

type AuthContext struct {
	echo.Context
	AuthContext *Auth
}

type Auth struct {
	AuthType     int
	OauthToken   *oauth2.Token
	CookieHeader string
}

func AuthMiddleware(next echo.HandlerFunc) echo.HandlerFunc {

	return func(c echo.Context) error {
		ac := &AuthContext{c, nil}
		ac.AuthContext = &Auth{}
		ac.AuthContext.AuthType = AUTH_TYPE_NONE

		cookie := c.Request().Header.Get("X-Google-Cookie")
		//
		if cookie != "" {
			ac.AuthContext.AuthType = AUTH_TYPE_COOKIES
			ac.AuthContext.CookieHeader = cookie
		} else {
			token := extractToken(c)
			if token != nil {
				ac.AuthContext.AuthType = AUTH_TYPE_OAUTH
				ac.AuthContext.OauthToken = token
				fmt.Println("using OAUTH context")
			}
		}
		//	token := extractToken(c)
		/**/

		return next(ac)
	}
}
