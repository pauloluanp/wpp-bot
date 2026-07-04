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

  getMe = async (req, res) => {
    try {
      const user = await this.userService.getMe(req.user.id);
      return res.json(user);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  updateProfile = async (req, res) => {
    const { name, age } = req.body;

    try {
      const result = await this.userService.updateProfile(req.user.id, {
        name,
        age,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Senha atual e nova senha são obrigatórias" });
    }

    try {
      const result = await this.userService.changePassword(req.user.id, {
        currentPassword,
        newPassword,
      });
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
