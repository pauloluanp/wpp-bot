export default class UserController {
  constructor(userService) {
    this.userService = userService;
  }

  createUser = async (req, res) => {
    const { name, email, password, age, planId } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "E-mail e senha são obrigatórios" });
    }

    try {
      const user = await this.userService.createUser({
        name,
        email,
        password,
        age,
        planId,
      });
      return res.status(201).json(user);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  updatePlan = async (req, res) => {
    const userId = req.user.id;
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: "planId é obrigatório" });
    }

    try {
      const result = await this.userService.updatePlan(userId, planId);
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "E-mail e senha são obrigatórios" });
    }

    try {
      const result = await this.userService.login({ email, password });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };
}
