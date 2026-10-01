interface Alert {
	msg: string;
	type: "success" | "error";
	action?: string | { label: string; run: () => void };
}
