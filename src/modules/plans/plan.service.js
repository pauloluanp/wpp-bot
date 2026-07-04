export default class PlanService {
  constructor(planRepository) {
    this.planRepository = planRepository;
  }

  async listPlans() {
    return this.planRepository.listPlans();
  }

  async getPlanById(id) {
    return this.planRepository.getPlanById(id);
  }
}
