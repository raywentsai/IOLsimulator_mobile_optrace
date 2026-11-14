"""Fit the Landolt C pilot and generate the app model and report figure."""

import json
from pathlib import Path

import matplotlib
import numpy as np
from scipy.optimize import curve_fit

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "optics/calibration/landolt-c.json"
MODEL = ROOT / "src/lib/data/gaussian-calibration.json"
FIGURE = ROOT / "docs/phase13b-gaussian-calibration.svg"
BASELINE_LOGMAR = 0.0
LN_10 = np.log(10)


def evaluate_mar(loss, scale):
    return scale * np.expm1(LN_10 * loss)


# All models minimize squared error in added angular sigma.
CANDIDATES = (
    ("Linear", "aΔ + b", lambda x, a, b: a * x + b, (15, -2), ((0, -np.inf), (np.inf, np.inf))),
    ("Log-linear inverse", "a exp(bΔ)", lambda x, a, b: a * np.exp(b * x), (1, 3), (0, np.inf)),
    ("Gaussian quadrature", "a √(10^(2Δ) − 1)", lambda x, a: a * np.sqrt(np.expm1(2 * LN_10 * x)),
     (2,), (0, np.inf)),
    ("Anchored power", "aΔ^b", lambda x, a, b: a * x**b, (16, 2), (0, np.inf)),
    ("Anchored MAR", "a(10^Δ − 1)", evaluate_mar, (2,), (0, np.inf)),
)


def fit(loss, sigma):
    results = []
    for name, formula, predict, initial, bounds in CANDIDATES:
        params = fit_coefficients(predict, initial, bounds, loss, sigma)
        residuals = sigma - predict(loss, *params)
        loo = [
            sigma[i] - predict(loss[i], *fit_coefficients(
                predict, initial, bounds, np.delete(loss, i), np.delete(sigma, i)
            ))
            for i in range(len(sigma))
        ]
        results.append({
            "name": name, "formula": formula, "predict": predict, "parameters": params,
            "residuals": residuals,
            "r2": 1 - np.sum(residuals**2) / np.sum((sigma - sigma.mean())**2),
            "rmse": np.sqrt(np.mean(residuals**2)),
            "looRmse": np.sqrt(np.mean(np.square(loo))),
        })
    return results


def fit_coefficients(predict, initial, bounds, loss, sigma):
    if predict is evaluate_mar:
        mar_delta = evaluate_mar(loss, 1)
        return np.array([(mar_delta @ sigma) / (mar_delta @ mar_delta)])
    return curve_fit(predict, loss, sigma, p0=initial, bounds=bounds)[0]


def plot(loss, sigma, results):
    plt.rcParams.update({"svg.hashsalt": "phase13b", "svg.fonttype": "none", "font.size": 10})
    figure, (curve, errors) = plt.subplots(
        2, 1, figsize=(9, 7.35), sharex=True, height_ratios=[3, 1], layout="constrained"
    )
    figure.suptitle("Landolt C calibration · 30 cm", x=.08, ha="left", fontsize=17, fontweight="bold")
    linear, exponential, quadrature, power, selected = results
    styles = ((linear, "#6b7280", "--"), (exponential, "#9a4e35", "-."),
              (quadrature, "#716296", ":"), (power, "#43764e", "--"), (selected, "#145caf", "-"))
    line = np.linspace(loss.min(), loss.max(), 250)
    for model, color, style in styles:
        predict, params = model["predict"], model["parameters"]
        chosen = model is selected
        label = f"{model['name']}  {model['formula']}  •  R² {model['r2']:.3f}  ·  RMSE {model['rmse']:.2f}′"
        if chosen:
            label = f"Selected  σ = {params[0]:.3f}(10^Δ − 1)  •  R² {model['r2']:.3f}  ·  RMSE {model['rmse']:.2f}′"
            for lo, hi in [(0, loss.min()), (loss.max(), max(.85, loss.max() + .05))]:
                extension = np.linspace(lo, hi, 50)
                curve.plot(extension, predict(extension, *params), color=color, linestyle=":", linewidth=2)
        curve.plot(line, predict(line, *params), color=color, linestyle=style, linewidth=2.6 if chosen else 1.4, label=label)
        errors.plot(loss, model["residuals"], marker="o", color=color, linestyle=style,
                    linewidth=1.8 if chosen else 1, markersize=4)

    curve.scatter(loss, sigma, color="#121826", edgecolor="white", linewidth=.8, s=52, zorder=5, label="Reported thresholds")
    handles, labels = curve.get_legend_handles_labels()
    order = [5, 4, 0, 1, 2, 3]
    curve.legend([handles[i] for i in order], [labels[i] for i in order], loc="upper left", fontsize=9)
    curve.set_ylabel("Added Gaussian σ per axis (arcmin)")
    errors.set_ylabel("Observed − fitted σ (arcmin)")
    errors.set_xlabel("logMAR loss Δ relative to the observer baseline (pilot assumes 0.0 logMAR)")
    errors.axhline(0, color="#798591", linewidth=.8, zorder=0)
    for axis in (curve, errors):
        for start, end in [(0, loss.min()), (loss.max(), max(.85, loss.max() + .05))]:
            axis.axvspan(start, end, color="#eaf1fa", alpha=.75, zorder=-1)
        axis.spines[["top", "right"]].set_visible(False)
        axis.grid(axis="y", color="#dde4eb", linewidth=.55)
    curve.set_title("Reported thresholds and model fits · shaded regions lack pilot observations", loc="left", fontsize=10)
    curve.set_xlim(0, max(.85, loss.max() + .05))
    figure.savefig(FIGURE, metadata={"Date": None, "Title": "Landolt C Gaussian blur calibration at 30 cm"})
    plt.close(figure)
    lines = FIGURE.read_text(encoding="utf-8").splitlines()
    FIGURE.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="utf-8", newline="\n")


def main():
    dataset = json.loads(DATA.read_text(encoding="utf-8"))
    if dataset["schemaVersion"] != 1 or dataset["sigmaUnit"] != "arcmin":
        raise ValueError("Expected version 1 observations in arcmin")
    observations = sorted(
        (point["logMAR"] - session["baselineLogMAR"], point["sigmaArcmin"])
        for session in dataset["sessions"]
        for point in session["measurements"]
    )
    loss, sigma = np.array(observations).reshape(-1, 2).T
    if (len(np.unique(loss)) < 3 or not np.isfinite([loss, sigma]).all()
            or (loss <= 0).any() or (sigma < 0).any() or np.ptp(sigma) == 0):
        raise ValueError("Expected varying non-negative sigma at three or more distinct positive losses")

    results = fit(loss, sigma)
    selected = results[-1]
    config = {
        "version": 1,
        "form": "anchored-mar",
        "baselineLogMAR": BASELINE_LOGMAR,
        "coefficients": {"scaleArcmin": round(float(selected["parameters"][0]), 9)},
        "observedLossLogMAR": [round(float(loss.min()), 9), round(float(loss.max()), 9)],
    }
    MODEL.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8", newline="\n")
    plot(loss, sigma, results)
    for model in results:
        print(f"{model['name']}: {model['parameters']}, R2={model['r2']:.6f}, "
              f"RMSE={model['rmse']:.6f}, LOO RMSE={model['looRmse']:.6f}, "
              f"residuals={np.round(model['residuals'], 4)}")


if __name__ == "__main__":
    main()
