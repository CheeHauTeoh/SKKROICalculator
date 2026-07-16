import streamlit as st


st.set_page_config(
    page_title="SK Keong ROI Calculator",
    page_icon="📈",
    layout="centered",
    initial_sidebar_state="collapsed",
)


DEFAULT_BUSINESS_INPUTS = {
    "annual_revenue": 13_000_000.0,
    "gross_margin": 0.12,
    "inventory_on_hand": 1_800_000.0,
    "accounts_receivable": 1_800_000.0,
    "dead_slow_stock": 300_000.0,
    "bad_debt": 90_000.0,
    "carrying_cost": 0.22,
    "annual_cost": 6_000.0,
}

DEFAULT_SCENARIOS = {
    "Conservative": {
        "stockout_rate": 0.03,
        "recovery_rate": 0.40,
        "inventory_reduction": 0.06,
        "dso_reduction": 5.0,
        "bad_debt_reduction": 0.30,
        "admin_savings": 10_000.0,
    },
    "Base": {
        "stockout_rate": 0.04,
        "recovery_rate": 0.50,
        "inventory_reduction": 0.10,
        "dso_reduction": 8.0,
        "bad_debt_reduction": 0.40,
        "admin_savings": 20_000.0,
    },
    "Upside": {
        "stockout_rate": 0.06,
        "recovery_rate": 0.60,
        "inventory_reduction": 0.14,
        "dso_reduction": 12.0,
        "bad_debt_reduction": 0.50,
        "admin_savings": 30_000.0,
    },
}


def calculate_roi(business: dict, levers: dict) -> dict:
    """Replicate the formulas in SK Keong ROI Calculator.xlsx."""
    lost_sales = business["annual_revenue"] * levers["stockout_rate"]
    sales_recovered = lost_sales * levers["recovery_rate"]
    margin_on_recovered_sales = sales_recovered * business["gross_margin"]
    inventory_cash_released = business["inventory_on_hand"] * levers["inventory_reduction"]
    carrying_cost_saved = inventory_cash_released * business["carrying_cost"]
    ar_cash_released = business["annual_revenue"] / 365 * levers["dso_reduction"]
    bad_debt_saved = business["bad_debt"] * levers["bad_debt_reduction"]
    admin_time_saved = levers["admin_savings"]

    one_time_cash_released = inventory_cash_released + ar_cash_released
    recurring_hard_benefit = (
        margin_on_recovered_sales
        + carrying_cost_saved
        + bad_debt_saved
        + admin_time_saved
    )
    first_year_cash_impact = one_time_cash_released + recurring_hard_benefit
    annual_cost = business["annual_cost"]
    roi = first_year_cash_impact / annual_cost if annual_cost else None
    payback_weeks = annual_cost / (recurring_hard_benefit / 52) if recurring_hard_benefit else None

    return {
        "lost_sales": lost_sales,
        "sales_recovered": sales_recovered,
        "margin_on_recovered_sales": margin_on_recovered_sales,
        "inventory_cash_released": inventory_cash_released,
        "carrying_cost_saved": carrying_cost_saved,
        "ar_cash_released": ar_cash_released,
        "bad_debt_saved": bad_debt_saved,
        "admin_time_saved": admin_time_saved,
        "one_time_cash_released": one_time_cash_released,
        "recurring_hard_benefit": recurring_hard_benefit,
        "first_year_cash_impact": first_year_cash_impact,
        "roi": roi,
        "payback_weeks": payback_weeks,
    }


def rm(value: float) -> str:
    return f"RM {value:,.0f}"


def percentage(value: float | None) -> str:
    return "—" if value is None else f"{value:,.0%}"


def reset_defaults() -> None:
    for key, value in DEFAULT_BUSINESS_INPUTS.items():
        state_key = (
            f"business_{key}_percent"
            if key in {"gross_margin", "carrying_cost"}
            else f"business_{key}"
        )
        st.session_state[state_key] = value * 100 if key in {"gross_margin", "carrying_cost"} else value
    for scenario, values in DEFAULT_SCENARIOS.items():
        for key, value in values.items():
            state_key = (
                f"{scenario}_{key}_percent"
                if key in {"stockout_rate", "recovery_rate", "inventory_reduction", "bad_debt_reduction"}
                else f"{scenario}_{key}"
            )
            st.session_state[state_key] = value * 100 if state_key.endswith("_percent") else value


def business_inputs() -> dict:
    st.subheader("Business inputs")
    st.caption("Enter the current annual figures. Values are in Malaysian ringgit (RM).")
    with st.container(border=True):
        annual_revenue = st.number_input(
            "Annual revenue (RM)", min_value=0.0, step=100_000.0,
            key="business_annual_revenue", format="%.0f",
        )
        gross_margin = st.number_input(
            "Gross margin (%)", min_value=0.0, max_value=100.0, step=1.0,
            key="business_gross_margin_percent", format="%.1f",
        ) / 100
        inventory_on_hand = st.number_input(
            "Inventory on hand (RM)", min_value=0.0, step=50_000.0,
            key="business_inventory_on_hand", format="%.0f",
        )
        with st.expander("More business inputs"):
            st.caption("Reference fields below are retained from the workbook; its current formulas do not use them in the ROI calculation.")
            accounts_receivable = st.number_input(
                "Accounts receivable (RM)", min_value=0.0, step=50_000.0,
                key="business_accounts_receivable", format="%.0f",
            )
            dead_slow_stock = st.number_input(
                "Dead / slow stock (RM)", min_value=0.0, step=25_000.0,
                key="business_dead_slow_stock", format="%.0f",
            )
            bad_debt = st.number_input(
                "Bad debt per year (RM)", min_value=0.0, step=5_000.0,
                key="business_bad_debt", format="%.0f",
            )
            carrying_cost = st.number_input(
                "Inventory carrying cost (% / year)", min_value=0.0, max_value=100.0,
                step=1.0, key="business_carrying_cost_percent", format="%.1f",
            ) / 100
            annual_cost = st.number_input(
                "Estimated annual Claude + tooling cost (RM)", min_value=0.0,
                step=500.0, key="business_annual_cost", format="%.0f",
            )
    return {
        "annual_revenue": annual_revenue,
        "gross_margin": gross_margin,
        "inventory_on_hand": inventory_on_hand,
        "accounts_receivable": accounts_receivable,
        "dead_slow_stock": dead_slow_stock,
        "bad_debt": bad_debt,
        "carrying_cost": carrying_cost,
        "annual_cost": annual_cost,
    }


def scenario_inputs(scenario: str) -> dict:
    st.subheader(f"{scenario} assumptions")
    with st.container(border=True):
        stockout_rate = st.number_input(
            "Stock-outs as % of sales", min_value=0.0, max_value=100.0, step=1.0,
            key=f"{scenario}_stockout_rate_percent", format="%.1f",
        ) / 100
        recovery_rate = st.number_input(
            "% of stock-out sales recovered", min_value=0.0, max_value=100.0, step=1.0,
            key=f"{scenario}_recovery_rate_percent", format="%.1f",
        ) / 100
        inventory_reduction = st.number_input(
            "Inventory reduction (%)", min_value=0.0, max_value=100.0, step=1.0,
            key=f"{scenario}_inventory_reduction_percent", format="%.1f",
        ) / 100
        dso_reduction = st.number_input(
            "DSO days reduced", min_value=0.0, step=1.0,
            key=f"{scenario}_dso_reduction", format="%.0f",
        )
        bad_debt_reduction = st.number_input(
            "Bad-debt reduction (%)", min_value=0.0, max_value=100.0, step=1.0,
            key=f"{scenario}_bad_debt_reduction_percent", format="%.1f",
        ) / 100
        admin_savings = st.number_input(
            "Admin time saved (RM / year)", min_value=0.0, step=5_000.0,
            key=f"{scenario}_admin_savings", format="%.0f",
        )
    return {
        "stockout_rate": stockout_rate,
        "recovery_rate": recovery_rate,
        "inventory_reduction": inventory_reduction,
        "dso_reduction": dso_reduction,
        "bad_debt_reduction": bad_debt_reduction,
        "admin_savings": admin_savings,
    }


def initialise_state() -> None:
    if "business_annual_revenue" in st.session_state:
        return
    for key, value in DEFAULT_BUSINESS_INPUTS.items():
        if key in {"gross_margin", "carrying_cost"}:
            st.session_state[f"business_{key}_percent"] = value * 100
        else:
            st.session_state[f"business_{key}"] = value
    for scenario, values in DEFAULT_SCENARIOS.items():
        for key, value in values.items():
            if key in {"stockout_rate", "recovery_rate", "inventory_reduction", "bad_debt_reduction"}:
                st.session_state[f"{scenario}_{key}_percent"] = value * 100
            else:
                st.session_state[f"{scenario}_{key}"] = value


initialise_state()

st.markdown(
    """
    <style>
      .block-container {max-width: 700px; padding-top: 1.35rem; padding-bottom: 3rem;}
      h1 {font-size: 1.75rem !important; margin-bottom: 0.2rem !important;}
      .stMetric {background: #f6f8f6; border: 1px solid #dce5dc; border-radius: 12px; padding: 0.75rem;}
      [data-testid="stExpander"] {border-radius: 10px;}
      @media (max-width: 640px) {
        .block-container {padding-left: 1rem; padding-right: 1rem;}
        .stMetric {padding: 0.55rem;}
      }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title("📈 SK Keong ROI Calculator")
st.caption("Estimate first-year cash impact, ROI and payback from operational improvements.")

toolbar_left, toolbar_right = st.columns([3, 1])
scenario = toolbar_left.segmented_control(
    "Scenario", options=list(DEFAULT_SCENARIOS), default="Base", label_visibility="collapsed",
)
if toolbar_right.button("Reset", use_container_width=True):
    reset_defaults()
    st.rerun()

business = business_inputs()
levers = scenario_inputs(scenario)
result = calculate_roi(business, levers)

st.subheader("Results")
first_row = st.columns(2)
first_row[0].metric("First-year cash impact", rm(result["first_year_cash_impact"]))
first_row[1].metric("First-year ROI", percentage(result["roi"]))
second_row = st.columns(2)
second_row[0].metric("One-time cash released", rm(result["one_time_cash_released"]))
second_row[1].metric(
    "Payback period",
    "—" if result["payback_weeks"] is None else f"{result['payback_weeks']:.1f} weeks",
)

with st.expander("See calculation breakdown"):
    st.markdown("**Recurring hard benefit (per year)**")
    recurring = {
        "Margin on recovered sales": result["margin_on_recovered_sales"],
        "Inventory carrying cost saved": result["carrying_cost_saved"],
        "Bad debt saved": result["bad_debt_saved"],
        "Admin time saved": result["admin_time_saved"],
    }
    for label, value in recurring.items():
        st.write(f"{label}: **{rm(value)}**")
    st.write(f"Recurring hard benefit: **{rm(result['recurring_hard_benefit'])} / year**")
    st.divider()
    st.write(f"Recovered sales (top line): **{rm(result['sales_recovered'])} / year**")
    st.write(f"Inventory cash released: **{rm(result['inventory_cash_released'])}**")
    st.write(f"AR cash released: **{rm(result['ar_cash_released'])}**")

st.info(
    "One-time cash is the working capital released through lower inventory and faster collections. "
    "Recurring benefit is generated each year. Results remain illustrative until validated with SK Keong data."
)
