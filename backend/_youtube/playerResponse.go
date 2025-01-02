package _youtube

type ArtistResponse struct {
	ResponseContext struct {
		VisitorData           string `json:"visitorData"`
		ServiceTrackingParams []struct {
			Service string `json:"service"`
			Params  []struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			} `json:"params"`
		} `json:"serviceTrackingParams"`
		MaxAgeSeconds int `json:"maxAgeSeconds"`
	} `json:"responseContext"`
	Contents struct {
		SingleColumnBrowseResultsRenderer struct {
			Tabs []struct {
				TabRenderer struct {
					Content struct {
						SectionListRenderer struct {
							Contents []struct {
								MusicShelfRenderer struct {
									Title struct {
										Runs []struct {
											Text               string `json:"text"`
											NavigationEndpoint struct {
												ClickTrackingParams string `json:"clickTrackingParams"`
												BrowseEndpoint      struct {
													BrowseID                              string `json:"browseId"`
													Params                                string `json:"params"`
													BrowseEndpointContextSupportedConfigs struct {
														BrowseEndpointContextMusicConfig struct {
															PageType string `json:"pageType"`
														} `json:"browseEndpointContextMusicConfig"`
													} `json:"browseEndpointContextSupportedConfigs"`
												} `json:"browseEndpoint"`
											} `json:"navigationEndpoint"`
										} `json:"runs"`
									} `json:"title"`
									Contents []struct {
										MusicResponsiveListItemRenderer struct {
											TrackingParams string `json:"trackingParams"`
											Thumbnail      struct {
												MusicThumbnailRenderer struct {
													Thumbnail struct {
														Thumbnails []struct {
															URL    string `json:"url"`
															Width  int    `json:"width"`
															Height int    `json:"height"`
														} `json:"thumbnails"`
													} `json:"thumbnail"`
													ThumbnailCrop  string `json:"thumbnailCrop"`
													ThumbnailScale string `json:"thumbnailScale"`
													TrackingParams string `json:"trackingParams"`
												} `json:"musicThumbnailRenderer"`
											} `json:"thumbnail"`
											Overlay struct {
												MusicItemThumbnailOverlayRenderer struct {
													Background struct {
														VerticalGradient struct {
															GradientLayerColors []string `json:"gradientLayerColors"`
														} `json:"verticalGradient"`
													} `json:"background"`
													Content struct {
														MusicPlayButtonRenderer struct {
															PlayNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Index          int    `json:"index"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"playNavigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
															PlayIcon       struct {
																IconType string `json:"iconType"`
															} `json:"playIcon"`
															PauseIcon struct {
																IconType string `json:"iconType"`
															} `json:"pauseIcon"`
															IconColor             int64 `json:"iconColor"`
															BackgroundColor       int   `json:"backgroundColor"`
															ActiveBackgroundColor int   `json:"activeBackgroundColor"`
															LoadingIndicatorColor int64 `json:"loadingIndicatorColor"`
															PlayingIcon           struct {
																IconType string `json:"iconType"`
															} `json:"playingIcon"`
															IconLoadingColor      int    `json:"iconLoadingColor"`
															ActiveScaleFactor     int    `json:"activeScaleFactor"`
															ButtonSize            string `json:"buttonSize"`
															RippleTarget          string `json:"rippleTarget"`
															AccessibilityPlayData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPlayData"`
															AccessibilityPauseData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPauseData"`
														} `json:"musicPlayButtonRenderer"`
													} `json:"content"`
													ContentPosition string `json:"contentPosition"`
													DisplayStyle    string `json:"displayStyle"`
												} `json:"musicItemThumbnailOverlayRenderer"`
											} `json:"overlay"`
											FlexColumns []struct {
												MusicResponsiveListItemFlexColumnRenderer struct {
													Text struct {
														Runs []struct {
															Text               string `json:"text"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
														} `json:"runs"`
													} `json:"text"`
													DisplayPriority string `json:"displayPriority"`
												} `json:"musicResponsiveListItemFlexColumnRenderer"`
											} `json:"flexColumns"`
											Menu struct {
												MenuRenderer struct {
													Items []struct {
														MenuNavigationItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Params         string `json:"params"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuNavigationItemRenderer,omitempty"`
														MenuServiceItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															ServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																QueueAddEndpoint    struct {
																	QueueTarget struct {
																		VideoID      string `json:"videoId"`
																		OnEmptyQueue struct {
																			ClickTrackingParams string `json:"clickTrackingParams"`
																			WatchEndpoint       struct {
																				VideoID string `json:"videoId"`
																			} `json:"watchEndpoint"`
																		} `json:"onEmptyQueue"`
																	} `json:"queueTarget"`
																	QueueInsertPosition string `json:"queueInsertPosition"`
																	Commands            []struct {
																		ClickTrackingParams string `json:"clickTrackingParams"`
																		AddToToastAction    struct {
																			Item struct {
																				NotificationTextRenderer struct {
																					SuccessResponseText struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"successResponseText"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"notificationTextRenderer"`
																			} `json:"item"`
																		} `json:"addToToastAction"`
																	} `json:"commands"`
																} `json:"queueAddEndpoint"`
															} `json:"serviceEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuServiceItemRenderer,omitempty"`
													} `json:"items"`
													TrackingParams  string `json:"trackingParams"`
													TopLevelButtons []struct {
														LikeButtonRenderer struct {
															Target struct {
																VideoID string `json:"videoId"`
															} `json:"target"`
															LikeStatus                string `json:"likeStatus"`
															TrackingParams            string `json:"trackingParams"`
															LikesAllowed              bool   `json:"likesAllowed"`
															DislikeNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"dislikeNavigationEndpoint"`
															LikeCommand struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"likeCommand"`
														} `json:"likeButtonRenderer"`
													} `json:"topLevelButtons"`
													Accessibility struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibility"`
												} `json:"menuRenderer"`
											} `json:"menu"`
											Badges []struct {
												MusicInlineBadgeRenderer struct {
													TrackingParams string `json:"trackingParams"`
													Icon           struct {
														IconType string `json:"iconType"`
													} `json:"icon"`
													AccessibilityData struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibilityData"`
												} `json:"musicInlineBadgeRenderer"`
											} `json:"badges"`
											PlaylistItemData struct {
												VideoID string `json:"videoId"`
											} `json:"playlistItemData"`
										} `json:"musicResponsiveListItemRenderer,omitempty"`
										MusicResponsiveListItemRenderer0 struct {
											TrackingParams string `json:"trackingParams"`
											Thumbnail      struct {
												MusicThumbnailRenderer struct {
													Thumbnail struct {
														Thumbnails []struct {
															URL    string `json:"url"`
															Width  int    `json:"width"`
															Height int    `json:"height"`
														} `json:"thumbnails"`
													} `json:"thumbnail"`
													ThumbnailCrop  string `json:"thumbnailCrop"`
													ThumbnailScale string `json:"thumbnailScale"`
													TrackingParams string `json:"trackingParams"`
												} `json:"musicThumbnailRenderer"`
											} `json:"thumbnail"`
											Overlay struct {
												MusicItemThumbnailOverlayRenderer struct {
													Background struct {
														VerticalGradient struct {
															GradientLayerColors []string `json:"gradientLayerColors"`
														} `json:"verticalGradient"`
													} `json:"background"`
													Content struct {
														MusicPlayButtonRenderer struct {
															PlayNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Index          int    `json:"index"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"playNavigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
															PlayIcon       struct {
																IconType string `json:"iconType"`
															} `json:"playIcon"`
															PauseIcon struct {
																IconType string `json:"iconType"`
															} `json:"pauseIcon"`
															IconColor             int64 `json:"iconColor"`
															BackgroundColor       int   `json:"backgroundColor"`
															ActiveBackgroundColor int   `json:"activeBackgroundColor"`
															LoadingIndicatorColor int64 `json:"loadingIndicatorColor"`
															PlayingIcon           struct {
																IconType string `json:"iconType"`
															} `json:"playingIcon"`
															IconLoadingColor      int    `json:"iconLoadingColor"`
															ActiveScaleFactor     int    `json:"activeScaleFactor"`
															ButtonSize            string `json:"buttonSize"`
															RippleTarget          string `json:"rippleTarget"`
															AccessibilityPlayData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPlayData"`
															AccessibilityPauseData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPauseData"`
														} `json:"musicPlayButtonRenderer"`
													} `json:"content"`
													ContentPosition string `json:"contentPosition"`
													DisplayStyle    string `json:"displayStyle"`
												} `json:"musicItemThumbnailOverlayRenderer"`
											} `json:"overlay"`
											FlexColumns []struct {
												MusicResponsiveListItemFlexColumnRenderer struct {
													Text struct {
														Runs []struct {
															Text               string `json:"text"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
														} `json:"runs"`
													} `json:"text"`
													DisplayPriority string `json:"displayPriority"`
												} `json:"musicResponsiveListItemFlexColumnRenderer"`
											} `json:"flexColumns"`
											Menu struct {
												MenuRenderer struct {
													Items []struct {
														MenuNavigationItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Params         string `json:"params"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuNavigationItemRenderer,omitempty"`
														MenuServiceItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															ServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																QueueAddEndpoint    struct {
																	QueueTarget struct {
																		VideoID      string `json:"videoId"`
																		OnEmptyQueue struct {
																			ClickTrackingParams string `json:"clickTrackingParams"`
																			WatchEndpoint       struct {
																				VideoID string `json:"videoId"`
																			} `json:"watchEndpoint"`
																		} `json:"onEmptyQueue"`
																	} `json:"queueTarget"`
																	QueueInsertPosition string `json:"queueInsertPosition"`
																	Commands            []struct {
																		ClickTrackingParams string `json:"clickTrackingParams"`
																		AddToToastAction    struct {
																			Item struct {
																				NotificationTextRenderer struct {
																					SuccessResponseText struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"successResponseText"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"notificationTextRenderer"`
																			} `json:"item"`
																		} `json:"addToToastAction"`
																	} `json:"commands"`
																} `json:"queueAddEndpoint"`
															} `json:"serviceEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuServiceItemRenderer,omitempty"`
													} `json:"items"`
													TrackingParams  string `json:"trackingParams"`
													TopLevelButtons []struct {
														LikeButtonRenderer struct {
															Target struct {
																VideoID string `json:"videoId"`
															} `json:"target"`
															LikeStatus                string `json:"likeStatus"`
															TrackingParams            string `json:"trackingParams"`
															LikesAllowed              bool   `json:"likesAllowed"`
															DislikeNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"dislikeNavigationEndpoint"`
															LikeCommand struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"likeCommand"`
														} `json:"likeButtonRenderer"`
													} `json:"topLevelButtons"`
													Accessibility struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibility"`
												} `json:"menuRenderer"`
											} `json:"menu"`
											PlaylistItemData struct {
												VideoID string `json:"videoId"`
											} `json:"playlistItemData"`
										} `json:"musicResponsiveListItemRenderer,omitempty"`
										MusicResponsiveListItemRenderer1 struct {
											TrackingParams string `json:"trackingParams"`
											Thumbnail      struct {
												MusicThumbnailRenderer struct {
													Thumbnail struct {
														Thumbnails []struct {
															URL    string `json:"url"`
															Width  int    `json:"width"`
															Height int    `json:"height"`
														} `json:"thumbnails"`
													} `json:"thumbnail"`
													ThumbnailCrop  string `json:"thumbnailCrop"`
													ThumbnailScale string `json:"thumbnailScale"`
													TrackingParams string `json:"trackingParams"`
												} `json:"musicThumbnailRenderer"`
											} `json:"thumbnail"`
											Overlay struct {
												MusicItemThumbnailOverlayRenderer struct {
													Background struct {
														VerticalGradient struct {
															GradientLayerColors []string `json:"gradientLayerColors"`
														} `json:"verticalGradient"`
													} `json:"background"`
													Content struct {
														MusicPlayButtonRenderer struct {
															PlayNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Index          int    `json:"index"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"playNavigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
															PlayIcon       struct {
																IconType string `json:"iconType"`
															} `json:"playIcon"`
															PauseIcon struct {
																IconType string `json:"iconType"`
															} `json:"pauseIcon"`
															IconColor             int64 `json:"iconColor"`
															BackgroundColor       int   `json:"backgroundColor"`
															ActiveBackgroundColor int   `json:"activeBackgroundColor"`
															LoadingIndicatorColor int64 `json:"loadingIndicatorColor"`
															PlayingIcon           struct {
																IconType string `json:"iconType"`
															} `json:"playingIcon"`
															IconLoadingColor      int    `json:"iconLoadingColor"`
															ActiveScaleFactor     int    `json:"activeScaleFactor"`
															ButtonSize            string `json:"buttonSize"`
															RippleTarget          string `json:"rippleTarget"`
															AccessibilityPlayData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPlayData"`
															AccessibilityPauseData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPauseData"`
														} `json:"musicPlayButtonRenderer"`
													} `json:"content"`
													ContentPosition string `json:"contentPosition"`
													DisplayStyle    string `json:"displayStyle"`
												} `json:"musicItemThumbnailOverlayRenderer"`
											} `json:"overlay"`
											FlexColumns []struct {
												MusicResponsiveListItemFlexColumnRenderer struct {
													Text struct {
														Runs []struct {
															Text               string `json:"text"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
														} `json:"runs"`
													} `json:"text"`
													DisplayPriority string `json:"displayPriority"`
												} `json:"musicResponsiveListItemFlexColumnRenderer"`
											} `json:"flexColumns"`
											Menu struct {
												MenuRenderer struct {
													Items []struct {
														MenuNavigationItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Params         string `json:"params"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuNavigationItemRenderer,omitempty"`
														MenuServiceItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															ServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																QueueAddEndpoint    struct {
																	QueueTarget struct {
																		VideoID      string `json:"videoId"`
																		OnEmptyQueue struct {
																			ClickTrackingParams string `json:"clickTrackingParams"`
																			WatchEndpoint       struct {
																				VideoID string `json:"videoId"`
																			} `json:"watchEndpoint"`
																		} `json:"onEmptyQueue"`
																	} `json:"queueTarget"`
																	QueueInsertPosition string `json:"queueInsertPosition"`
																	Commands            []struct {
																		ClickTrackingParams string `json:"clickTrackingParams"`
																		AddToToastAction    struct {
																			Item struct {
																				NotificationTextRenderer struct {
																					SuccessResponseText struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"successResponseText"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"notificationTextRenderer"`
																			} `json:"item"`
																		} `json:"addToToastAction"`
																	} `json:"commands"`
																} `json:"queueAddEndpoint"`
															} `json:"serviceEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuServiceItemRenderer,omitempty"`
													} `json:"items"`
													TrackingParams  string `json:"trackingParams"`
													TopLevelButtons []struct {
														LikeButtonRenderer struct {
															Target struct {
																VideoID string `json:"videoId"`
															} `json:"target"`
															LikeStatus                string `json:"likeStatus"`
															TrackingParams            string `json:"trackingParams"`
															LikesAllowed              bool   `json:"likesAllowed"`
															DislikeNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"dislikeNavigationEndpoint"`
															LikeCommand struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"likeCommand"`
														} `json:"likeButtonRenderer"`
													} `json:"topLevelButtons"`
													Accessibility struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibility"`
												} `json:"menuRenderer"`
											} `json:"menu"`
											PlaylistItemData struct {
												VideoID string `json:"videoId"`
											} `json:"playlistItemData"`
										} `json:"musicResponsiveListItemRenderer,omitempty"`
										MusicResponsiveListItemRenderer2 struct {
											TrackingParams string `json:"trackingParams"`
											Thumbnail      struct {
												MusicThumbnailRenderer struct {
													Thumbnail struct {
														Thumbnails []struct {
															URL    string `json:"url"`
															Width  int    `json:"width"`
															Height int    `json:"height"`
														} `json:"thumbnails"`
													} `json:"thumbnail"`
													ThumbnailCrop  string `json:"thumbnailCrop"`
													ThumbnailScale string `json:"thumbnailScale"`
													TrackingParams string `json:"trackingParams"`
												} `json:"musicThumbnailRenderer"`
											} `json:"thumbnail"`
											Overlay struct {
												MusicItemThumbnailOverlayRenderer struct {
													Background struct {
														VerticalGradient struct {
															GradientLayerColors []string `json:"gradientLayerColors"`
														} `json:"verticalGradient"`
													} `json:"background"`
													Content struct {
														MusicPlayButtonRenderer struct {
															PlayNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Index          int    `json:"index"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"playNavigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
															PlayIcon       struct {
																IconType string `json:"iconType"`
															} `json:"playIcon"`
															PauseIcon struct {
																IconType string `json:"iconType"`
															} `json:"pauseIcon"`
															IconColor             int64 `json:"iconColor"`
															BackgroundColor       int   `json:"backgroundColor"`
															ActiveBackgroundColor int   `json:"activeBackgroundColor"`
															LoadingIndicatorColor int64 `json:"loadingIndicatorColor"`
															PlayingIcon           struct {
																IconType string `json:"iconType"`
															} `json:"playingIcon"`
															IconLoadingColor      int    `json:"iconLoadingColor"`
															ActiveScaleFactor     int    `json:"activeScaleFactor"`
															ButtonSize            string `json:"buttonSize"`
															RippleTarget          string `json:"rippleTarget"`
															AccessibilityPlayData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPlayData"`
															AccessibilityPauseData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPauseData"`
														} `json:"musicPlayButtonRenderer"`
													} `json:"content"`
													ContentPosition string `json:"contentPosition"`
													DisplayStyle    string `json:"displayStyle"`
												} `json:"musicItemThumbnailOverlayRenderer"`
											} `json:"overlay"`
											FlexColumns []struct {
												MusicResponsiveListItemFlexColumnRenderer struct {
													Text struct {
														Runs []struct {
															Text               string `json:"text"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
														} `json:"runs"`
													} `json:"text"`
													DisplayPriority string `json:"displayPriority"`
												} `json:"musicResponsiveListItemFlexColumnRenderer"`
											} `json:"flexColumns"`
											Menu struct {
												MenuRenderer struct {
													Items []struct {
														MenuNavigationItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															NavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																WatchEndpoint       struct {
																	VideoID        string `json:"videoId"`
																	PlaylistID     string `json:"playlistId"`
																	Params         string `json:"params"`
																	LoggingContext struct {
																		VssLoggingContext struct {
																			SerializedContextData string `json:"serializedContextData"`
																		} `json:"vssLoggingContext"`
																	} `json:"loggingContext"`
																	WatchEndpointMusicSupportedConfigs struct {
																		WatchEndpointMusicConfig struct {
																			MusicVideoType string `json:"musicVideoType"`
																		} `json:"watchEndpointMusicConfig"`
																	} `json:"watchEndpointMusicSupportedConfigs"`
																} `json:"watchEndpoint"`
															} `json:"navigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuNavigationItemRenderer,omitempty"`
														MenuServiceItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															ServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																QueueAddEndpoint    struct {
																	QueueTarget struct {
																		VideoID      string `json:"videoId"`
																		OnEmptyQueue struct {
																			ClickTrackingParams string `json:"clickTrackingParams"`
																			WatchEndpoint       struct {
																				VideoID string `json:"videoId"`
																			} `json:"watchEndpoint"`
																		} `json:"onEmptyQueue"`
																	} `json:"queueTarget"`
																	QueueInsertPosition string `json:"queueInsertPosition"`
																	Commands            []struct {
																		ClickTrackingParams string `json:"clickTrackingParams"`
																		AddToToastAction    struct {
																			Item struct {
																				NotificationTextRenderer struct {
																					SuccessResponseText struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"successResponseText"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"notificationTextRenderer"`
																			} `json:"item"`
																		} `json:"addToToastAction"`
																	} `json:"commands"`
																} `json:"queueAddEndpoint"`
															} `json:"serviceEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuServiceItemRenderer,omitempty"`
													} `json:"items"`
													TrackingParams  string `json:"trackingParams"`
													TopLevelButtons []struct {
														LikeButtonRenderer struct {
															Target struct {
																VideoID string `json:"videoId"`
															} `json:"target"`
															LikeStatus                string `json:"likeStatus"`
															TrackingParams            string `json:"trackingParams"`
															LikesAllowed              bool   `json:"likesAllowed"`
															DislikeNavigationEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"dislikeNavigationEndpoint"`
															LikeCommand struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"likeCommand"`
														} `json:"likeButtonRenderer"`
													} `json:"topLevelButtons"`
													Accessibility struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibility"`
												} `json:"menuRenderer"`
											} `json:"menu"`
											PlaylistItemData struct {
												VideoID string `json:"videoId"`
											} `json:"playlistItemData"`
										} `json:"musicResponsiveListItemRenderer,omitempty"`
									} `json:"contents"`
									TrackingParams string `json:"trackingParams"`
									BottomText     struct {
										Runs []struct {
											Text string `json:"text"`
										} `json:"runs"`
									} `json:"bottomText"`
									BottomEndpoint struct {
										ClickTrackingParams string `json:"clickTrackingParams"`
										BrowseEndpoint      struct {
											BrowseID                              string `json:"browseId"`
											Params                                string `json:"params"`
											BrowseEndpointContextSupportedConfigs struct {
												BrowseEndpointContextMusicConfig struct {
													PageType string `json:"pageType"`
												} `json:"browseEndpointContextMusicConfig"`
											} `json:"browseEndpointContextSupportedConfigs"`
										} `json:"browseEndpoint"`
									} `json:"bottomEndpoint"`
									ShelfDivider struct {
										MusicShelfDividerRenderer struct {
											Hidden bool `json:"hidden"`
										} `json:"musicShelfDividerRenderer"`
									} `json:"shelfDivider"`
								} `json:"musicShelfRenderer,omitempty"`
								MusicCarouselShelfRenderer struct {
									Header struct {
										MusicCarouselShelfBasicHeaderRenderer struct {
											Title struct {
												Runs []struct {
													Text string `json:"text"`
												} `json:"runs"`
											} `json:"title"`
											AccessibilityData struct {
												AccessibilityData struct {
													Label string `json:"label"`
												} `json:"accessibilityData"`
											} `json:"accessibilityData"`
											HeaderStyle    string `json:"headerStyle"`
											TrackingParams string `json:"trackingParams"`
										} `json:"musicCarouselShelfBasicHeaderRenderer"`
									} `json:"header"`
									Contents []struct {
										MusicTwoRowItemRenderer struct {
											ThumbnailRenderer struct {
												MusicThumbnailRenderer struct {
													Thumbnail struct {
														Thumbnails []struct {
															URL    string `json:"url"`
															Width  int    `json:"width"`
															Height int    `json:"height"`
														} `json:"thumbnails"`
													} `json:"thumbnail"`
													ThumbnailCrop  string `json:"thumbnailCrop"`
													ThumbnailScale string `json:"thumbnailScale"`
													TrackingParams string `json:"trackingParams"`
												} `json:"musicThumbnailRenderer"`
											} `json:"thumbnailRenderer"`
											AspectRatio string `json:"aspectRatio"`
											Title       struct {
												Runs []struct {
													Text               string `json:"text"`
													NavigationEndpoint struct {
														ClickTrackingParams string `json:"clickTrackingParams"`
														BrowseEndpoint      struct {
															BrowseID                              string `json:"browseId"`
															Params                                string `json:"params"`
															BrowseEndpointContextSupportedConfigs struct {
																BrowseEndpointContextMusicConfig struct {
																	PageType string `json:"pageType"`
																} `json:"browseEndpointContextMusicConfig"`
															} `json:"browseEndpointContextSupportedConfigs"`
														} `json:"browseEndpoint"`
													} `json:"navigationEndpoint"`
												} `json:"runs"`
											} `json:"title"`
											Subtitle struct {
												Runs []struct {
													Text string `json:"text"`
												} `json:"runs"`
											} `json:"subtitle"`
											NavigationEndpoint struct {
												ClickTrackingParams string `json:"clickTrackingParams"`
												BrowseEndpoint      struct {
													BrowseID                              string `json:"browseId"`
													Params                                string `json:"params"`
													BrowseEndpointContextSupportedConfigs struct {
														BrowseEndpointContextMusicConfig struct {
															PageType string `json:"pageType"`
														} `json:"browseEndpointContextMusicConfig"`
													} `json:"browseEndpointContextSupportedConfigs"`
												} `json:"browseEndpoint"`
											} `json:"navigationEndpoint"`
											TrackingParams string `json:"trackingParams"`
											Menu           struct {
												MenuRenderer struct {
													Items []struct {
														MenuNavigationItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															NavigationEndpoint struct {
																ClickTrackingParams   string `json:"clickTrackingParams"`
																WatchPlaylistEndpoint struct {
																	PlaylistID string `json:"playlistId"`
																	Params     string `json:"params"`
																} `json:"watchPlaylistEndpoint"`
															} `json:"navigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuNavigationItemRenderer,omitempty"`
														MenuServiceItemRenderer struct {
															Text struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"text"`
															Icon struct {
																IconType string `json:"iconType"`
															} `json:"icon"`
															ServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																QueueAddEndpoint    struct {
																	QueueTarget struct {
																		PlaylistID   string `json:"playlistId"`
																		OnEmptyQueue struct {
																			ClickTrackingParams string `json:"clickTrackingParams"`
																			WatchEndpoint       struct {
																				PlaylistID string `json:"playlistId"`
																			} `json:"watchEndpoint"`
																		} `json:"onEmptyQueue"`
																	} `json:"queueTarget"`
																	QueueInsertPosition string `json:"queueInsertPosition"`
																	Commands            []struct {
																		ClickTrackingParams string `json:"clickTrackingParams"`
																		AddToToastAction    struct {
																			Item struct {
																				NotificationTextRenderer struct {
																					SuccessResponseText struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"successResponseText"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"notificationTextRenderer"`
																			} `json:"item"`
																		} `json:"addToToastAction"`
																	} `json:"commands"`
																} `json:"queueAddEndpoint"`
															} `json:"serviceEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"menuServiceItemRenderer,omitempty"`
														ToggleMenuServiceItemRenderer struct {
															DefaultText struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"defaultText"`
															DefaultIcon struct {
																IconType string `json:"iconType"`
															} `json:"defaultIcon"`
															DefaultServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																ModalEndpoint       struct {
																	Modal struct {
																		ModalWithTitleAndButtonRenderer struct {
																			Title struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"title"`
																			Content struct {
																				Runs []struct {
																					Text string `json:"text"`
																				} `json:"runs"`
																			} `json:"content"`
																			Button struct {
																				ButtonRenderer struct {
																					Style      string `json:"style"`
																					IsDisabled bool   `json:"isDisabled"`
																					Text       struct {
																						Runs []struct {
																							Text string `json:"text"`
																						} `json:"runs"`
																					} `json:"text"`
																					NavigationEndpoint struct {
																						ClickTrackingParams string `json:"clickTrackingParams"`
																						SignInEndpoint      struct {
																							Hack bool `json:"hack"`
																						} `json:"signInEndpoint"`
																					} `json:"navigationEndpoint"`
																					TrackingParams string `json:"trackingParams"`
																				} `json:"buttonRenderer"`
																			} `json:"button"`
																		} `json:"modalWithTitleAndButtonRenderer"`
																	} `json:"modal"`
																} `json:"modalEndpoint"`
															} `json:"defaultServiceEndpoint"`
															ToggledText struct {
																Runs []struct {
																	Text string `json:"text"`
																} `json:"runs"`
															} `json:"toggledText"`
															ToggledIcon struct {
																IconType string `json:"iconType"`
															} `json:"toggledIcon"`
															ToggledServiceEndpoint struct {
																ClickTrackingParams string `json:"clickTrackingParams"`
																LikeEndpoint        struct {
																	Status string `json:"status"`
																	Target struct {
																		PlaylistID string `json:"playlistId"`
																	} `json:"target"`
																} `json:"likeEndpoint"`
															} `json:"toggledServiceEndpoint"`
															TrackingParams string `json:"trackingParams"`
														} `json:"toggleMenuServiceItemRenderer,omitempty"`
													} `json:"items"`
													TrackingParams string `json:"trackingParams"`
													Accessibility  struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibility"`
												} `json:"menuRenderer"`
											} `json:"menu"`
											ThumbnailOverlay struct {
												MusicItemThumbnailOverlayRenderer struct {
													Background struct {
														VerticalGradient struct {
															GradientLayerColors []string `json:"gradientLayerColors"`
														} `json:"verticalGradient"`
													} `json:"background"`
													Content struct {
														MusicPlayButtonRenderer struct {
															PlayNavigationEndpoint struct {
																ClickTrackingParams   string `json:"clickTrackingParams"`
																WatchPlaylistEndpoint struct {
																	PlaylistID string `json:"playlistId"`
																} `json:"watchPlaylistEndpoint"`
															} `json:"playNavigationEndpoint"`
															TrackingParams string `json:"trackingParams"`
															PlayIcon       struct {
																IconType string `json:"iconType"`
															} `json:"playIcon"`
															PauseIcon struct {
																IconType string `json:"iconType"`
															} `json:"pauseIcon"`
															IconColor             int64 `json:"iconColor"`
															BackgroundColor       int64 `json:"backgroundColor"`
															ActiveBackgroundColor int64 `json:"activeBackgroundColor"`
															LoadingIndicatorColor int64 `json:"loadingIndicatorColor"`
															PlayingIcon           struct {
																IconType string `json:"iconType"`
															} `json:"playingIcon"`
															IconLoadingColor      int     `json:"iconLoadingColor"`
															ActiveScaleFactor     float64 `json:"activeScaleFactor"`
															ButtonSize            string  `json:"buttonSize"`
															RippleTarget          string  `json:"rippleTarget"`
															AccessibilityPlayData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPlayData"`
															AccessibilityPauseData struct {
																AccessibilityData struct {
																	Label string `json:"label"`
																} `json:"accessibilityData"`
															} `json:"accessibilityPauseData"`
														} `json:"musicPlayButtonRenderer"`
													} `json:"content"`
													ContentPosition string `json:"contentPosition"`
													DisplayStyle    string `json:"displayStyle"`
												} `json:"musicItemThumbnailOverlayRenderer"`
											} `json:"thumbnailOverlay"`
											SubtitleBadges []struct {
												MusicInlineBadgeRenderer struct {
													TrackingParams string `json:"trackingParams"`
													Icon           struct {
														IconType string `json:"iconType"`
													} `json:"icon"`
													AccessibilityData struct {
														AccessibilityData struct {
															Label string `json:"label"`
														} `json:"accessibilityData"`
													} `json:"accessibilityData"`
												} `json:"musicInlineBadgeRenderer"`
											} `json:"subtitleBadges"`
										} `json:"musicTwoRowItemRenderer"`
									} `json:"contents"`
									TrackingParams string `json:"trackingParams"`
									ItemSize       string `json:"itemSize"`
								} `json:"musicCarouselShelfRenderer,omitempty"`
								MusicDescriptionShelfRenderer struct {
									Header struct {
										Runs []struct {
											Text string `json:"text"`
										} `json:"runs"`
									} `json:"header"`
									Subheader struct {
										Runs []struct {
											Text string `json:"text"`
										} `json:"runs"`
									} `json:"subheader"`
									Description struct {
										Runs []struct {
											Text string `json:"text"`
										} `json:"runs"`
									} `json:"description"`
									MoreButton struct {
										ToggleButtonRenderer struct {
											IsToggled   bool `json:"isToggled"`
											IsDisabled  bool `json:"isDisabled"`
											DefaultIcon struct {
												IconType string `json:"iconType"`
											} `json:"defaultIcon"`
											DefaultText struct {
												Runs []struct {
													Text string `json:"text"`
												} `json:"runs"`
											} `json:"defaultText"`
											ToggledIcon struct {
												IconType string `json:"iconType"`
											} `json:"toggledIcon"`
											ToggledText struct {
												Runs []struct {
													Text string `json:"text"`
												} `json:"runs"`
											} `json:"toggledText"`
											TrackingParams string `json:"trackingParams"`
										} `json:"toggleButtonRenderer"`
									} `json:"moreButton"`
									TrackingParams string `json:"trackingParams"`
								} `json:"musicDescriptionShelfRenderer,omitempty"`
							} `json:"contents"`
							TrackingParams string `json:"trackingParams"`
						} `json:"sectionListRenderer"`
					} `json:"content"`
					TrackingParams string `json:"trackingParams"`
				} `json:"tabRenderer"`
			} `json:"tabs"`
		} `json:"singleColumnBrowseResultsRenderer"`
	} `json:"contents"`
	Header struct {
		MusicImmersiveHeaderRenderer struct {
			Title struct {
				Runs []struct {
					Text string `json:"text"`
				} `json:"runs"`
			} `json:"title"`
			SubscriptionButton struct {
				SubscribeButtonRenderer struct {
					SubscriberCountText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"subscriberCountText"`
					Subscribed                       bool   `json:"subscribed"`
					Enabled                          bool   `json:"enabled"`
					Type                             string `json:"type"`
					ChannelID                        string `json:"channelId"`
					ShowPreferences                  bool   `json:"showPreferences"`
					SubscriberCountWithSubscribeText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"subscriberCountWithSubscribeText"`
					SubscribedButtonText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"subscribedButtonText"`
					UnsubscribedButtonText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"unsubscribedButtonText"`
					TrackingParams        string `json:"trackingParams"`
					UnsubscribeButtonText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"unsubscribeButtonText"`
					ServiceEndpoints []struct {
						ClickTrackingParams string `json:"clickTrackingParams"`
						SubscribeEndpoint   struct {
							ChannelIds []string `json:"channelIds"`
							Params     string   `json:"params"`
						} `json:"subscribeEndpoint,omitempty"`
						SignalServiceEndpoint struct {
							Signal  string `json:"signal"`
							Actions []struct {
								ClickTrackingParams string `json:"clickTrackingParams"`
								OpenPopupAction     struct {
									Popup struct {
										ConfirmDialogRenderer struct {
											TrackingParams string `json:"trackingParams"`
											DialogMessages []struct {
												Runs []struct {
													Text string `json:"text"`
												} `json:"runs"`
											} `json:"dialogMessages"`
											ConfirmButton struct {
												ButtonRenderer struct {
													Style string `json:"style"`
													Size  string `json:"size"`
													Text  struct {
														Runs []struct {
															Text string `json:"text"`
														} `json:"runs"`
													} `json:"text"`
													ServiceEndpoint struct {
														ClickTrackingParams string `json:"clickTrackingParams"`
														UnsubscribeEndpoint struct {
															ChannelIds []string `json:"channelIds"`
														} `json:"unsubscribeEndpoint"`
													} `json:"serviceEndpoint"`
													TrackingParams string `json:"trackingParams"`
												} `json:"buttonRenderer"`
											} `json:"confirmButton"`
											CancelButton struct {
												ButtonRenderer struct {
													Style string `json:"style"`
													Size  string `json:"size"`
													Text  struct {
														Runs []struct {
															Text string `json:"text"`
														} `json:"runs"`
													} `json:"text"`
													TrackingParams string `json:"trackingParams"`
												} `json:"buttonRenderer"`
											} `json:"cancelButton"`
										} `json:"confirmDialogRenderer"`
									} `json:"popup"`
									PopupType string `json:"popupType"`
								} `json:"openPopupAction"`
							} `json:"actions"`
						} `json:"signalServiceEndpoint,omitempty"`
					} `json:"serviceEndpoints"`
					LongSubscriberCountText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
						Accessibility struct {
							AccessibilityData struct {
								Label string `json:"label"`
							} `json:"accessibilityData"`
						} `json:"accessibility"`
					} `json:"longSubscriberCountText"`
					ShortSubscriberCountText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"shortSubscriberCountText"`
					SubscribeAccessibility struct {
						AccessibilityData struct {
							Label string `json:"label"`
						} `json:"accessibilityData"`
					} `json:"subscribeAccessibility"`
					UnsubscribeAccessibility struct {
						AccessibilityData struct {
							Label string `json:"label"`
						} `json:"accessibilityData"`
					} `json:"unsubscribeAccessibility"`
					SignInEndpoint struct {
						ClickTrackingParams string `json:"clickTrackingParams"`
						ModalEndpoint       struct {
							Modal struct {
								ModalWithTitleAndButtonRenderer struct {
									Title struct {
										Runs []struct {
											Text string `json:"text"`
										} `json:"runs"`
									} `json:"title"`
									Content struct {
										Runs []struct {
											Text string `json:"text"`
										} `json:"runs"`
									} `json:"content"`
									Button struct {
										ButtonRenderer struct {
											Style      string `json:"style"`
											IsDisabled bool   `json:"isDisabled"`
											Text       struct {
												Runs []struct {
													Text string `json:"text"`
												} `json:"runs"`
											} `json:"text"`
											NavigationEndpoint struct {
												ClickTrackingParams string `json:"clickTrackingParams"`
												SignInEndpoint      struct {
													Hack bool `json:"hack"`
												} `json:"signInEndpoint"`
											} `json:"navigationEndpoint"`
											TrackingParams string `json:"trackingParams"`
										} `json:"buttonRenderer"`
									} `json:"button"`
								} `json:"modalWithTitleAndButtonRenderer"`
							} `json:"modal"`
						} `json:"modalEndpoint"`
					} `json:"signInEndpoint"`
				} `json:"subscribeButtonRenderer"`
			} `json:"subscriptionButton"`
			Description struct {
				Runs []struct {
					Text string `json:"text"`
				} `json:"runs"`
			} `json:"description"`
			MoreButton struct {
				ToggleButtonRenderer struct {
					IsToggled   bool `json:"isToggled"`
					IsDisabled  bool `json:"isDisabled"`
					DefaultIcon struct {
						IconType string `json:"iconType"`
					} `json:"defaultIcon"`
					DefaultText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"defaultText"`
					ToggledIcon struct {
						IconType string `json:"iconType"`
					} `json:"toggledIcon"`
					ToggledText struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"toggledText"`
					TrackingParams string `json:"trackingParams"`
				} `json:"toggleButtonRenderer"`
			} `json:"moreButton"`
			Menu struct {
				MenuRenderer struct {
					Items []struct {
						MenuNavigationItemRenderer struct {
							Text struct {
								Runs []struct {
									Text string `json:"text"`
								} `json:"runs"`
							} `json:"text"`
							Icon struct {
								IconType string `json:"iconType"`
							} `json:"icon"`
							NavigationEndpoint struct {
								ClickTrackingParams string `json:"clickTrackingParams"`
								ShareEntityEndpoint struct {
									SerializedShareEntity string `json:"serializedShareEntity"`
									SharePanelType        string `json:"sharePanelType"`
								} `json:"shareEntityEndpoint"`
							} `json:"navigationEndpoint"`
							TrackingParams string `json:"trackingParams"`
						} `json:"menuNavigationItemRenderer"`
					} `json:"items"`
					TrackingParams string `json:"trackingParams"`
					Accessibility  struct {
						AccessibilityData struct {
							Label string `json:"label"`
						} `json:"accessibilityData"`
					} `json:"accessibility"`
				} `json:"menuRenderer"`
			} `json:"menu"`
			Thumbnail struct {
				MusicThumbnailRenderer struct {
					Thumbnail struct {
						Thumbnails []struct {
							URL    string `json:"url"`
							Width  int    `json:"width"`
							Height int    `json:"height"`
						} `json:"thumbnails"`
					} `json:"thumbnail"`
					ThumbnailCrop  string `json:"thumbnailCrop"`
					ThumbnailScale string `json:"thumbnailScale"`
					TrackingParams string `json:"trackingParams"`
				} `json:"musicThumbnailRenderer"`
			} `json:"thumbnail"`
			TrackingParams string `json:"trackingParams"`
			PlayButton     struct {
				ButtonRenderer struct {
					Style string `json:"style"`
					Size  string `json:"size"`
					Text  struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"text"`
					Icon struct {
						IconType string `json:"iconType"`
					} `json:"icon"`
					NavigationEndpoint struct {
						ClickTrackingParams string `json:"clickTrackingParams"`
						WatchEndpoint       struct {
							VideoID        string `json:"videoId"`
							PlaylistID     string `json:"playlistId"`
							Params         string `json:"params"`
							LoggingContext struct {
								VssLoggingContext struct {
									SerializedContextData string `json:"serializedContextData"`
								} `json:"vssLoggingContext"`
							} `json:"loggingContext"`
						} `json:"watchEndpoint"`
					} `json:"navigationEndpoint"`
					Accessibility struct {
						Label string `json:"label"`
					} `json:"accessibility"`
					TrackingParams    string `json:"trackingParams"`
					AccessibilityData struct {
						AccessibilityData struct {
							Label string `json:"label"`
						} `json:"accessibilityData"`
					} `json:"accessibilityData"`
				} `json:"buttonRenderer"`
			} `json:"playButton"`
			StartRadioButton struct {
				ButtonRenderer struct {
					Text struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
					} `json:"text"`
					Icon struct {
						IconType string `json:"iconType"`
					} `json:"icon"`
					NavigationEndpoint struct {
						ClickTrackingParams string `json:"clickTrackingParams"`
						WatchEndpoint       struct {
							VideoID        string `json:"videoId"`
							PlaylistID     string `json:"playlistId"`
							Params         string `json:"params"`
							LoggingContext struct {
								VssLoggingContext struct {
									SerializedContextData string `json:"serializedContextData"`
								} `json:"vssLoggingContext"`
							} `json:"loggingContext"`
						} `json:"watchEndpoint"`
					} `json:"navigationEndpoint"`
					Accessibility struct {
						Label string `json:"label"`
					} `json:"accessibility"`
					TrackingParams    string `json:"trackingParams"`
					AccessibilityData struct {
						AccessibilityData struct {
							Label string `json:"label"`
						} `json:"accessibilityData"`
					} `json:"accessibilityData"`
				} `json:"buttonRenderer"`
			} `json:"startRadioButton"`
			ShareEndpoint struct {
				ClickTrackingParams string `json:"clickTrackingParams"`
				ShareEntityEndpoint struct {
					SerializedShareEntity string `json:"serializedShareEntity"`
					SharePanelType        string `json:"sharePanelType"`
				} `json:"shareEntityEndpoint"`
			} `json:"shareEndpoint"`
		} `json:"musicImmersiveHeaderRenderer"`
	} `json:"header"`
	TrackingParams string `json:"trackingParams"`
}
