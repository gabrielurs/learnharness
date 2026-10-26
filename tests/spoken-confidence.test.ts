import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIDENCE_STOPS, confidenceStopIndex, spokenConfidence } from "../src/core/question-core.ts";

/** Spoken confidence (fork, 2026-10-24): dictated thinking can set the slider. */
describe("spoken confidence", () => {
	it("reads numeric confidence with a confidence word beside it", () => {
		assert.equal(spokenConfidence("creo que es la b, estoy 50% seguro"), 50);
		assert.equal(spokenConfidence("estoy un 70 % seguro de esto"), 70);
		assert.equal(spokenConfidence("seguro al 80 por ciento"), 80);
		assert.equal(spokenConfidence("confianza de 90"), 90);
		assert.equal(spokenConfidence("tengo una confianza del 30%"), 30);
		assert.equal(spokenConfidence("estoy ochenta por ciento segura"), 80);
		assert.equal(spokenConfidence("I'm 60% sure it's c"), 60);
		assert.equal(spokenConfidence("confidence 100"), 100);
	});

	it("never reads a bare number in the math itself", () => {
		assert.equal(spokenConfidence("el 50% de 20 es 10"), null);
		assert.equal(spokenConfidence("3x + 3 porque multiplico por 3"), null);
		assert.equal(spokenConfidence(""), null);
	});

	it("reads the typical phrases, negatives before positives", () => {
		assert.equal(spokenConfidence("ni idea, voy a adivinar"), 0);
		assert.equal(spokenConfidence("no lo sé"), 0);
		assert.equal(spokenConfidence("no estoy seguro"), 30);
		assert.equal(spokenConfidence("no estoy muy segura de esto"), 30);
		assert.equal(spokenConfidence("bastante seguro"), 70);
		assert.equal(spokenConfidence("estoy seguro"), 90);
		assert.equal(spokenConfidence("segurísimo"), 100);
		assert.equal(spokenConfidence("totalmente segura"), 100);
		assert.equal(spokenConfidence("I'm not sure"), 30);
	});

	it("the last statement wins — a mid-sentence correction is meant", () => {
		assert.equal(spokenConfidence("estoy 90% seguro, bueno no, 50% seguro"), 50);
		assert.equal(spokenConfidence("estoy seguro... bueno, no estoy seguro"), 30);
		assert.equal(spokenConfidence("70% seguro"), 70, "the numeric form beats its own trailing word");
	});

	it("ordinary answer text is not read as confidence (audit, 2026-10-25)", () => {
		assert.equal(spokenConfidence("estoy setenta y cinco por ciento seguro"), 75);
		assert.equal(spokenConfidence("seventy-five percent sure"), 75);
		assert.equal(spokenConfidence("no estoy seguro de que sean 100"), 30);
		assert.equal(spokenConfidence("estoy seguro de que es 20"), 90);
		assert.equal(spokenConfidence("I'm sure the answer is 42"), 90);
		assert.equal(spokenConfidence("the 95% confidence interval"), null);
		assert.equal(spokenConfidence("intervalo de confianza del 95%"), null);
		assert.equal(spokenConfidence("con un nivel de confianza del 99%"), null);
		assert.equal(spokenConfidence("no dudo que sea la B"), 90);
		assert.equal(spokenConfidence("no tengo dudas"), 90);
		assert.equal(spokenConfidence("la opción segura es la 3"), null);
		assert.equal(spokenConfidence("there are 3 certain cases"), null);
		assert.equal(spokenConfidence("hay 3 opciones seguras"), null);
		assert.equal(spokenConfidence("I'm not sure about 2 of them"), 30);
		assert.equal(spokenConfidence("1234% seguro"), null);
		assert.equal(spokenConfidence("99,5% seguro"), null);
		assert.equal(spokenConfidence("tengo confianza de tenis"), null);
		// audit B6 (2026-10-26): an answer number is never read as confidence.
		assert.equal(spokenConfidence("sure of 2."), null);
		assert.equal(spokenConfidence("seguro que es 20"), null);
		assert.equal(spokenConfidence("la respuesta es 42, seguro"), null);
		assert.equal(spokenConfidence("x = 25% seguro de vida"), null);
		assert.equal(spokenConfidence("estoy seguro de 3 cosas"), 90);
		// a confidence NOUN still takes a bare number:
		assert.equal(spokenConfidence("confianza de 90"), 90);
		assert.equal(spokenConfidence("no estoy 100% seguro"), 30);
		assert.equal(spokenConfidence("no estoy cien por cien seguro"), 30);
		assert.equal(spokenConfidence("I'm not 100% sure"), 30);
		assert.equal(spokenConfidence("estoy seguro de 3 cosas"), 90);
		assert.equal(spokenConfidence("I'm sure of 2 things"), 90);
		assert.equal(spokenConfidence("tengo confianza en 3 de ellas"), null);
		assert.equal(spokenConfidence("intervalo del 95% de confianza"), null);
		// still read:
		assert.equal(spokenConfidence("con un 60% de confianza"), 60);
		assert.equal(spokenConfidence("tengo un 60% de confianza"), 60);
		assert.equal(spokenConfidence("estoy segura en un 80%"), 80);
		assert.equal(spokenConfidence("estoy 70 seguro"), 70);
		assert.equal(spokenConfidence("sure at 90 percent"), 90);
	});

	it("snaps to the nearest slider stop, ties down", () => {
		const stop = (v: number) => CONFIDENCE_STOPS[confidenceStopIndex(v)];
		assert.equal(stop(50), 50);
		assert.equal(stop(80), 70);
		assert.equal(stop(95), 90);
		assert.equal(stop(97), 100);
		assert.equal(stop(10), 0);
		assert.equal(stop(60), 50);
	});
});
