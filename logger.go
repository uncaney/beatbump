package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/rs/zerolog"
)

var Logger zerolog.Logger = NewLogger()

func LoggingMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {

		// call the next middleware/handler
		err := next(c)

		if err != nil {
			Logger.Error().Fields(map[string]interface{}{
				"query":    c.Request().URL.RawQuery,
				"response": c.Response().Status,
				"error":    err,
			}).Msg(c.Request().URL.Path)
			return err
		} else {
			Logger.Info().Fields(map[string]interface{}{
				"query":    c.Request().URL.RawQuery,
				"response": c.Response().Status,
				"UA":       c.Request().UserAgent(),
			}).Msg(c.Request().URL.Path)
		}

		return nil
	}
}

func NewLogger() zerolog.Logger {
	// create output configuration
	output := zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}

	// Format level: fatal, error, debug, info, warn
	output.FormatLevel = func(i interface{}) string {
		return strings.ToUpper(fmt.Sprintf("| %-6s|", i))
	}
	output.FormatFieldName = func(i interface{}) string {
		return fmt.Sprintf("%s:", i)
	}
	output.FormatFieldValue = func(i interface{}) string {
		return fmt.Sprintf("%s", i)
	}

	// format error
	output.FormatErrFieldName = func(i interface{}) string {
		return fmt.Sprintf("%s: ", i)
	}

	Logger := zerolog.New(output).With().Caller().Timestamp().Logger()

	return Logger
}

// accessLogFormat is Echo's default JSON access line plus, PF5-8, the two
// cache verdicts of the response: "cache" (X-Ytm-Cache: HIT, STALE, MISS or
// BYPASS on the cached routes and on the /cover 404 memo) and "mix_cache"
// (X-Ytm-Mix-Cache on me/mix). A perf audit can then compute HIT ratios per
// family from `docker logs` instead of curl probes. The default fields keep
// their names, order and types: e2e/perf-audit/log-latency.py and
// agents/ops/weekly.sh parse this line. Echo's ${header:} tag reads the
// request, hence the ${custom} tag for response headers.
const accessLogFormat = `{"time":"${time_rfc3339_nano}","id":"${id}","remote_ip":"${remote_ip}",` +
	`"host":"${host}","method":"${method}","uri":"${uri}","user_agent":"${user_agent}",` +
	`"status":${status},"error":"${error}","latency":${latency},"latency_human":"${latency_human}"` +
	`,"bytes_in":${bytes_in},"bytes_out":${bytes_out},${custom}}` + "\n"

// accessLogConfig builds the access logger config; out nil keeps Echo's
// default output (the Echo logger, stdout).
func accessLogConfig(out io.Writer) middleware.LoggerConfig {
	return middleware.LoggerConfig{
		Format: accessLogFormat,
		Output: out,
		CustomTagFunc: func(c echo.Context, buf *bytes.Buffer) (int, error) {
			h := c.Response().Header()
			n := buf.Len()
			buf.WriteString(`"cache":`)
			buf.Write(strconv.AppendQuote(nil, h.Get("X-Ytm-Cache")))
			buf.WriteString(`,"mix_cache":`)
			buf.Write(strconv.AppendQuote(nil, h.Get("X-Ytm-Mix-Cache")))
			return buf.Len() - n, nil
		},
	}
}
