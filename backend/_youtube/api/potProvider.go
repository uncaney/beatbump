package api

import (
	"log"
)

var extractor *PotokenExtractor

func init() {
	extractor = NewPotokenExtractor(3600)

	// Run a single update
	token, err := extractor.RunOnce()
	if err != nil {
		log.Fatal("Error during extraction:", err)
	}
	log.Printf("Extracted token: %s", token)

	// Running continuously for scheduled updates
	go extractor.Run()

}

func GetPoToken() *TokenInfo {
	return extractor.Get()
}
