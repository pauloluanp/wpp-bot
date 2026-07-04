export default class PlanController {
  constructor(planService) {
    this.planService = planService;
  }

  listPlans = async (req, res) => {
    try {
      const plans = await this.planService.listPlans();
      return res.json(plans);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
}
